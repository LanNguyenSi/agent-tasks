import { describe, expect, it, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const { mockWebhookDeliveryCreate, mockWebhookDeliveryDelete } = vi.hoisted(() => ({
  mockWebhookDeliveryCreate: vi.fn(),
  mockWebhookDeliveryDelete: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    webhookDelivery: {
      create: mockWebhookDeliveryCreate,
      delete: mockWebhookDeliveryDelete,
    },
  },
}));

import {
  claimWebhookDelivery,
  releaseWebhookDelivery,
} from "../../src/services/github-webhook.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("claimWebhookDelivery", () => {
  it("returns true when create resolves (first delivery — should process)", async () => {
    mockWebhookDeliveryCreate.mockResolvedValue({ id: "row-1", deliveryId: "abc123", event: "push" });

    const result = await claimWebhookDelivery("abc123", "push");

    expect(result).toBe(true);
    expect(mockWebhookDeliveryCreate).toHaveBeenCalledWith({
      data: { deliveryId: "abc123", event: "push" },
    });
  });

  it("returns false when create rejects with P2002 (duplicate delivery — should skip)", async () => {
    const dupError = new Prisma.PrismaClientKnownRequestError("dup", {
      code: "P2002",
      clientVersion: "5",
    });
    mockWebhookDeliveryCreate.mockRejectedValue(dupError);

    const result = await claimWebhookDelivery("abc123", "push");

    expect(result).toBe(false);
  });

  it("re-throws a non-P2002 error without swallowing it", async () => {
    const dbError = new Prisma.PrismaClientKnownRequestError("connection lost", {
      code: "P1001",
      clientVersion: "5",
    });
    mockWebhookDeliveryCreate.mockRejectedValue(dbError);

    await expect(claimWebhookDelivery("abc123", "push")).rejects.toThrow("connection lost");
  });

  it("re-throws a generic (non-Prisma) error", async () => {
    mockWebhookDeliveryCreate.mockRejectedValue(new Error("unexpected"));

    await expect(claimWebhookDelivery("abc123", "push")).rejects.toThrow("unexpected");
  });
});

describe("releaseWebhookDelivery", () => {
  it("calls delete with the correct where-clause", async () => {
    mockWebhookDeliveryDelete.mockResolvedValue({});

    await releaseWebhookDelivery("abc123");

    expect(mockWebhookDeliveryDelete).toHaveBeenCalledWith({
      where: { deliveryId: "abc123" },
    });
  });

  it("swallows P2025 (not-found) without throwing — safe to call defensively", async () => {
    const notFoundError = new Prisma.PrismaClientKnownRequestError("not found", {
      code: "P2025",
      clientVersion: "5",
    });
    mockWebhookDeliveryDelete.mockRejectedValue(notFoundError);

    await expect(releaseWebhookDelivery("abc123")).resolves.toBeUndefined();
  });

  it("re-throws a non-P2025 Prisma error", async () => {
    const dbError = new Prisma.PrismaClientKnownRequestError("db error", {
      code: "P1001",
      clientVersion: "5",
    });
    mockWebhookDeliveryDelete.mockRejectedValue(dbError);

    await expect(releaseWebhookDelivery("abc123")).rejects.toThrow("db error");
  });
});
