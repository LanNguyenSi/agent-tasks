import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

/** Every run owns one newly named schema; no reset, public-schema cleanup, or implicit runtime URL. */
export async function groundingPostgres() {
  const explicit = process.env.GROUNDING_TEST_DATABASE_URL ?? (process.env.NODE_ENV === "test" ? process.env.DATABASE_URL : undefined);
  if (!explicit) throw new Error("GROUNDING_TEST_DATABASE_URL is required for real PostgreSQL grounding tests");
  const url = new URL(explicit);
  if (!["postgresql:", "postgres:"].includes(url.protocol) || !/(?:^|[_-])test(?:[_-]|$)/i.test(decodeURIComponent(url.pathname.slice(1))))
    throw new Error("Grounding integration tests require an explicitly named test database");
  const schema = `grounding_test_${randomUUID().replaceAll("-", "")}`;
  url.searchParams.set("schema", schema);
  const datasourceUrl = url.toString();
  const clients: PrismaClient[] = [];
  const connect = (connectionLimit = 1) => {
    const clientUrl = new URL(datasourceUrl);
    clientUrl.searchParams.set("connection_limit", String(connectionLimit));
    const client = new PrismaClient({ datasourceUrl: clientUrl.toString() });
    clients.push(client);
    return client;
  };
  const admin = connect();
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  try {
    execFileSync(process.execPath, [resolve("../node_modules/prisma/build/index.js"), "db", "push", "--schema", "prisma/schema.prisma", "--skip-generate"], {
      env: { ...process.env, DATABASE_URL: datasourceUrl }, stdio: "pipe", timeout: 30000,
    });
  } catch (error) {
    await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.$disconnect();
    throw error;
  }
  return {
    schema, datasourceUrl, connect, db: connect(),
    async close() {
      await Promise.all(clients.filter(c => c !== admin).map(c => c.$disconnect()));
      await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.$disconnect();
    },
  };
}

/** Explicit rendezvous, not a timing sleep. */
export function barrier() {
  let release!: () => void;
  let entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  return { reached, release, async wait() { entered(); await resume; } };
}
