import { describe, expect, it, vi } from "vitest";
import { precheckChatQuota } from "./chatQuotaPrecheck";

describe("precheckChatQuota", () => {
  it("allows an unlimited user without loading usage", async () => {
    const loadUsedTalks = vi.fn(async () => 999);

    const result = await precheckChatQuota({
      limit: 5,
      loadIsUnlimited: async () => true,
      loadUsedTalks,
    });

    expect(result).toEqual({ kind: "allowed" });
    expect(loadUsedTalks).not.toHaveBeenCalled();
  });

  it("allows a user below the monthly limit", async () => {
    const result = await precheckChatQuota({
      limit: 5,
      loadIsUnlimited: async () => false,
      loadUsedTalks: async () => 4,
    });

    expect(result).toEqual({ kind: "allowed" });
  });

  it("rejects a user at the monthly limit", async () => {
    const result = await precheckChatQuota({
      limit: 5,
      loadIsUnlimited: async () => false,
      loadUsedTalks: async () => 5,
    });

    expect(result).toEqual({ kind: "exceeded", usedTalks: 5 });
  });

  it("stops safely when the usage lookup fails", async () => {
    const result = await precheckChatQuota({
      limit: 5,
      loadIsUnlimited: async () => false,
      loadUsedTalks: async () => {
        throw new Error("usage unavailable");
      },
    });

    expect(result).toEqual({ kind: "error", message: "usage unavailable" });
  });
});
