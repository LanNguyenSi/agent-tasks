import { describe, expect, it, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const { mockWebhookDeliveryCreate } = vi.hoisted(() => ({
  mockWebhookDeliveryCreate: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    webhookDelivery: {
      create: mockWebhookDeliveryCreate,
    },
  },
}));

import { claimWebhookDelivery } from "../../src/services/github-webhook.js";

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
