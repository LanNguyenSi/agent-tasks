/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock the API module: stub the three functions the section calls. Types come
// from the real module (vi.mock does not affect type resolution).
vi.mock("../../src/lib/api", () => ({
  uploadTaskAttachmentFile: vi.fn(),
  deleteTaskAttachment: vi.fn(),
  rawAttachmentUrl: (taskId: string, attId: string) =>
    `http://api.test/api/tasks/${taskId}/attachments/${attId}/raw`,
}));

import TaskAttachmentsSection, { validateAttachmentFile } from "../../src/components/TaskAttachmentsSection";
import { uploadTaskAttachmentFile, deleteTaskAttachment, type TaskAttachment, type User } from "../../src/lib/api";

const mockedUpload = vi.mocked(uploadTaskAttachmentFile);
const mockedDelete = vi.mocked(deleteTaskAttachment);

const USER: User = {
  id: "user-1",
  login: "lan",
  name: "Lan",
  avatarUrl: null,
  email: null,
  githubConnected: false,
  allowAgentPrCreate: false,
  allowAgentPrMerge: false,
  allowAgentPrComment: false,
};

function att(over: Partial<TaskAttachment>): TaskAttachment {
  return {
    id: "a-1",
    taskId: "task-1",
    name: "file",
    url: "/uploads/x",
    mimeType: null,
    sizeBytes: 0,
    type: "DOCUMENT",
    createdByUserId: "user-1",
    createdByUser: null,
    createdAt: "2026-06-04T00:00:00.000Z",
    ...over,
  };
}

const IMG = att({ id: "a-img", name: "shot.png", url: "/uploads/x.png", mimeType: "image/png", sizeBytes: 2048, type: "IMAGE", createdByUserId: "user-1" });
const DOC = att({ id: "a-doc", name: "notes.txt", url: "/uploads/y.txt", mimeType: "text/plain", sizeBytes: 50, type: "DOCUMENT", createdByUserId: "user-2" });

async function renderExpanded(props: Partial<React.ComponentProps<typeof TaskAttachmentsSection>> = {}) {
  const onError = vi.fn();
  const utils = render(
    <TaskAttachmentsSection taskId="task-1" initial={[IMG, DOC]} user={USER} onError={onError} {...props} />,
  );
  // CollapsibleSection starts collapsed; expand it.
  await userEvent.click(screen.getByRole("button", { name: /Attachments/ }));
  return { ...utils, onError };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("validateAttachmentFile", () => {
  it("accepts allowed types by MIME and by extension", () => {
    expect(validateAttachmentFile({ name: "a.png", type: "image/png", size: 10 })).toBeNull();
    expect(validateAttachmentFile({ name: "a.md", type: "", size: 10 })).toBeNull(); // extension fallback
    expect(validateAttachmentFile({ name: "a.csv", type: "text/csv", size: 10 })).toBeNull();
  });

  it("rejects empty, oversize, and disallowed files", () => {
    expect(validateAttachmentFile({ name: "a.png", type: "image/png", size: 0 })).toMatch(/empty/);
    expect(validateAttachmentFile({ name: "a.png", type: "image/png", size: 6 * 1024 * 1024 })).toMatch(/5 MiB/);
    expect(validateAttachmentFile({ name: "a.pdf", type: "application/pdf", size: 10 })).toMatch(/not an allowed type/);
  });
});

describe("TaskAttachmentsSection rendering", () => {
  it("renders an image thumbnail with the raw src and a text row with a download link", async () => {
    await renderExpanded();

    const img = screen.getByAltText("shot.png") as HTMLImageElement;
    expect(img).toBeInTheDocument();
    expect(img.src).toBe("http://api.test/api/tasks/task-1/attachments/a-img/raw");

    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    const download = screen.getByRole("link", { name: "Download" }) as HTMLAnchorElement;
    expect(download.getAttribute("href")).toBe("http://api.test/api/tasks/task-1/attachments/a-doc/raw");
  });

  it("shows Delete only for attachments the viewer uploaded (canManageAll=false)", async () => {
    await renderExpanded();
    // IMG was uploaded by user-1 (the viewer) → delete affordance present.
    expect(screen.getByRole("button", { name: "Delete shot.png" })).toBeInTheDocument();
    // DOC was uploaded by user-2 → no delete affordance for user-1.
    expect(screen.queryByRole("button", { name: "Delete notes.txt" })).not.toBeInTheDocument();
  });

  it("shows Delete for all when canManageAll is true", async () => {
    await renderExpanded({ canManageAll: true });
    expect(screen.getByRole("button", { name: "Delete notes.txt" })).toBeInTheDocument();
  });
});

describe("TaskAttachmentsSection upload", () => {
  it("uploads a selected file via the API and optimistically adds it", async () => {
    mockedUpload.mockResolvedValue(
      att({ id: "a-new", name: "new.png", url: "/uploads/new.png", mimeType: "image/png", sizeBytes: 99, type: "IMAGE", createdByUserId: "user-1" }),
    );
    const { container } = await renderExpanded();

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "new.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(mockedUpload).toHaveBeenCalledTimes(1));
    expect(mockedUpload).toHaveBeenCalledWith("task-1", file);
    expect(await screen.findByAltText("new.png")).toBeInTheDocument();
  });

  it("rejects a disallowed file client-side without calling the API", async () => {
    const { container, onError } = await renderExpanded();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const bad = new File([new Uint8Array([1, 2, 3])], "evil.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [bad] } });

    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringMatching(/not an allowed type/)));
    expect(mockedUpload).not.toHaveBeenCalled();
  });
});

describe("TaskAttachmentsSection delete", () => {
  it("requires a confirm step, then calls the API and removes the row optimistically", async () => {
    mockedDelete.mockResolvedValue(undefined);
    await renderExpanded();
    const user = userEvent.setup();

    expect(screen.getByAltText("shot.png")).toBeInTheDocument();
    // First click only arms the confirm; the API is not called yet.
    await user.click(screen.getByRole("button", { name: "Delete shot.png" }));
    expect(mockedDelete).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm delete shot.png" }));

    await waitFor(() => expect(mockedDelete).toHaveBeenCalledWith("task-1", "a-img"));
    await waitFor(() => expect(screen.queryByAltText("shot.png")).not.toBeInTheDocument());
  });

  it("Cancel aborts the delete without calling the API", async () => {
    await renderExpanded();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete shot.png" }));
    await user.click(screen.getByRole("button", { name: "Cancel delete shot.png" }));
    expect(mockedDelete).not.toHaveBeenCalled();
    expect(screen.getByAltText("shot.png")).toBeInTheDocument();
  });
});

describe("TaskAttachmentsSection drag-and-drop", () => {
  it("uploads files dropped on the zone", async () => {
    mockedUpload.mockResolvedValue(
      att({ id: "a-drop", name: "dropped.png", url: "/uploads/d.png", mimeType: "image/png", sizeBytes: 10, type: "IMAGE", createdByUserId: "user-1" }),
    );
    await renderExpanded();
    const zone = screen.getByRole("button", { name: "Upload an attachment" });
    const file = new File([new Uint8Array([0x89, 0x50])], "dropped.png", { type: "image/png" });
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });

    await waitFor(() => expect(mockedUpload).toHaveBeenCalledWith("task-1", file));
    expect(await screen.findByAltText("dropped.png")).toBeInTheDocument();
  });
});

describe("TaskAttachmentsSection lightbox", () => {
  it("opens a dialog with the raw image on thumbnail click and closes on Escape", async () => {
    await renderExpanded();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Preview shot.png" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    const img = within(dialog).getByAltText("shot.png") as HTMLImageElement;
    expect(img.src).toBe("http://api.test/api/tasks/task-1/attachments/a-img/raw");

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("TaskAttachmentsSection upload edge cases", () => {
  it("uploads the valid file and reports the bad one when a batch mixes both", async () => {
    mockedUpload.mockResolvedValue(
      att({ id: "a-ok", name: "ok.png", url: "/uploads/ok.png", mimeType: "image/png", sizeBytes: 5, type: "IMAGE", createdByUserId: "user-1" }),
    );
    const { container, onError } = await renderExpanded();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const good = new File([new Uint8Array([0x89, 0x50])], "ok.png", { type: "image/png" });
    const big = new File([new Uint8Array(6 * 1024 * 1024)], "huge.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [good, big] } });

    await waitFor(() => expect(mockedUpload).toHaveBeenCalledTimes(1));
    expect(mockedUpload).toHaveBeenCalledWith("task-1", good);
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/5 MiB/));
  });

  it("shows the busy state and disables the input while an upload is in flight", async () => {
    let resolveUpload!: (a: TaskAttachment) => void;
    mockedUpload.mockReturnValue(new Promise<TaskAttachment>((r) => { resolveUpload = r; }));
    const { container } = await renderExpanded();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array([0x89, 0x50])], "p.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText("Uploading…")).toBeInTheDocument();
    expect(input).toBeDisabled();

    resolveUpload(att({ id: "a-done", name: "p.png", url: "/uploads/p.png", mimeType: "image/png", sizeBytes: 2, type: "IMAGE", createdByUserId: "user-1" }));
    await waitFor(() => expect(input).not.toBeDisabled());
  });
});
