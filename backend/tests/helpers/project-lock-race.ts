import type { PrismaClient } from "@prisma/client";
import { barrier } from "./grounding-postgres.js";

/** The slice of the grounding Postgres store the race needs: extra connections. */
export interface RaceStore {
  connect(connectionLimit?: number): PrismaClient;
}

/**
 * The mutable database slot a test file's mocked prisma proxy reads from. The
 * race swaps in its own client for the duration of the requests and restores
 * the previous one afterwards.
 */
export interface RaceDbHolder {
  db: PrismaClient | undefined;
}

/**
 * Parks two requests behind the project row lock a third connection holds, in
 * arrival order, then releases it: both pass their pre-lock read before either
 * commits, so the second one is decided by the locked revalidate alone.
 */
export async function raceBehindProjectLock(
  ctx: { store: RaceStore; projectId: string; holder: RaceDbHolder },
  first: () => Response | Promise<Response>,
  second: () => Response | Promise<Response>,
) {
  const { store, projectId, holder } = ctx;
  const requestDb = store.connect(4);
  const blocker = store.connect();
  const observer = store.connect();
  const hold = barrier();
  let blockingPid = 0;
  const held = blocker.$transaction(
    async (tx) => {
      const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid FROM projects WHERE id = ${projectId} FOR UPDATE`;
      blockingPid = row!.pid;
      await hold.wait();
    },
    { timeout: 20000 },
  );
  await hold.reached;
  // Postgres queues lock waiters in arrival order, so counting the backends
  // blocked on the holder, directly or behind another waiter, tells that both
  // requests are parked, first one first.
  const waiters = async () => {
    const [row] = await observer.$queryRaw<{ n: number }[]>`
      WITH RECURSIVE chain(pid) AS (
        SELECT pid FROM pg_stat_activity WHERE ${blockingPid}::int = ANY(pg_blocking_pids(pid))
        UNION
        SELECT a.pid FROM pg_stat_activity a JOIN chain c ON c.pid = ANY(pg_blocking_pids(a.pid))
      )
      SELECT count(*)::int AS n FROM chain`;
    return row!.n;
  };
  const waitForWaiters = async (n: number) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if ((await waiters()) >= n) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`expected ${n} request(s) queued on the held project lock`);
  };
  const previous = holder.db;
  holder.db = requestDb;
  // Requests still in flight when a waiter check throws must settle before
  // their client disconnects.
  const pending: Promise<Response>[] = [];
  try {
    const firstPending = Promise.resolve(first());
    pending.push(firstPending);
    await waitForWaiters(1);
    const secondPending = Promise.resolve(second());
    pending.push(secondPending);
    await waitForWaiters(2);
    hold.release();
    await held;
    return await Promise.all([firstPending, secondPending]);
  } finally {
    hold.release();
    await held.catch(() => undefined);
    await Promise.allSettled(pending);
    holder.db = previous;
    // Each race opens up to six connections; release them now instead of at
    // the file's afterAll, so adding races cannot exhaust max_connections.
    await Promise.all([requestDb, blocker, observer].map((client) => client.$disconnect()));
  }
}
