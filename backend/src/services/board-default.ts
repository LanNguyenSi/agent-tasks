import { prisma } from "../lib/prisma.js";

export const DEFAULT_BOARD_CONFIG = {
  columns: [
    { id: "open", label: "Open", status: "open", color: "#6b7280" },
    { id: "in_progress", label: "In Progress", status: "in_progress", color: "#2563eb" },
    { id: "review", label: "Review", status: "review", color: "#f59e0b" },
    { id: "done", label: "Done", status: "done", color: "#16a34a" },
  ],
  groupBy: "none",
  filters: [],
} as const;

export async function ensureDefaultBoardForProject(projectId: string): Promise<void> {
  const existing = await prisma.board.findFirst({ where: { projectId } });
  if (existing) return;

  await prisma.board.create({
    data: {
      projectId,
      name: "Default Board",
      config: DEFAULT_BOARD_CONFIG,
    },
  });
}
