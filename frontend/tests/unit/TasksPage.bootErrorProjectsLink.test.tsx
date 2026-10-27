/** @vitest-environment jsdom */
/**
 * The "Projects" link on the /tasks boot error.
 *
 * A failed bootstrap (the team list lookup fails) leaves the page on its
 * boot-error state, but the team the URL names is still known there: the URL
 * needs no lookup. So the link carries it and /projects opens that team
 * without writing the URL; the boot error is not a reason to drop the team
 * the user navigated with. On a bare URL nothing is known and the link stays
 * bare.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import type { User } from "../../src/lib/api";

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
let query = "teamId=t1";
vi.mock("next/navigation", () => ({
  usePathname: () => "/tasks",
  useRouter: () => routerMocks,
  useSearchParams: () => new URLSearchParams(query),
}));

vi.mock("../../src/lib/api", () => ({
  getCurrentUser: vi.fn(),
  getTeams: vi.fn(),
  getProjects: vi.fn(),
  getTeamTasks: vi.fn(),
  updateTask: vi.fn(),
}));

vi.mock("../../src/components/tasks/NewTaskFlow", () => ({ default: () => null }));

import TasksPageRaw from "../../src/app/tasks/page";
import { withTeamList } from "./helpers/withTeamList";
const TasksPage = withTeamList(TasksPageRaw);
import { getCurrentUser, getTeams } from "../../src/lib/api";

const USER = { id: "u-1", login: "lan" } as User;

beforeEach(() => {
  vi.clearAllMocks();
  query = "teamId=t1";
  vi.mocked(getCurrentUser).mockResolvedValue(USER);
  // One failing lookup: the provider's first load. It stays failed (a list
  // in error is only retried when the page mounts into that state).
  vi.mocked(getTeams).mockRejectedValue(new Error("teams unavailable"));
});
afterEach(cleanup);

describe("/tasks boot error: the header Projects link", () => {
  it("carries the team the URL names (the URL needs no lookup)", async () => {
    render(<TasksPage />);
    await screen.findByText("Failed to load");
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Projects" })).toHaveAttribute(
        "href",
        "/projects?teamId=t1",
      ),
    );
  });

  it("stays bare on a URL that names no team", async () => {
    query = "";
    render(<TasksPage />);
    await screen.findByText("Failed to load");
    expect(screen.getByRole("link", { name: "Projects" })).toHaveAttribute("href", "/projects");
  });
});
