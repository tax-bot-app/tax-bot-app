import { describe, expect, it } from "vitest";

import { singleCheckoutIdempotencyKey } from "./singleCheckoutIdempotency";

const base = {
  userId: "11111111-1111-4111-8111-111111111111",
  purchase: "single_1" as const,
  priceId: "price_single_1",
  attemptId: "22222222-2222-4222-8222-222222222222",
};

describe("single Checkout idempotency", () => {
  it("is stable for a retry of the same purchase attempt", () => {
    expect(singleCheckoutIdempotencyKey(base)).toBe(
      singleCheckoutIdempotencyKey(base)
    );
  });

  it("allows a later intentional purchase with a new attempt id", () => {
    expect(singleCheckoutIdempotencyKey(base)).not.toBe(
      singleCheckoutIdempotencyKey({
        ...base,
        attemptId: "33333333-3333-4333-8333-333333333333",
      })
    );
  });

  it("does not expose user or Price IDs", () => {
    const key = singleCheckoutIdempotencyKey(base);
    expect(key).toMatch(/^sajikagen-single-checkout-v1-[a-f0-9]{64}$/);
    expect(key).not.toContain(base.userId);
    expect(key).not.toContain(base.priceId);
  });
});

