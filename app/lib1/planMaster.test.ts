import { describe, expect, it } from "vitest";

import { getPlan, normalizePlanKey } from "./planMaster";

describe("plan master monthly quotas", () => {
  it.each([
    ["free", 0],
    ["lite", 5],
    ["standard", 30],
    ["enterprise", 100],
  ] as const)("%s is limited to %i talks per month", (plan, expected) => {
    expect(getPlan(plan).monthlyQuota).toBe(expected);
  });

  it("normalizes an unknown DB plan to free", () => {
    expect(normalizePlanKey("unknown-plan")).toBe("free");
    expect(getPlan(normalizePlanKey("unknown-plan")).monthlyQuota).toBe(0);
  });
});
