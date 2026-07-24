import { describe, expect, it } from "vitest";

import { checkoutIdempotencyKey } from "./checkoutIdempotency";

describe("checkoutIdempotencyKey", () => {
  const base = {
    userId: "3ba8dc2a-720f-4e95-a04a-cf8b527c4f11",
    plan: "lite" as const,
    priceId: "price_lite",
  };

  it("returns the same key for the same logical checkout request", () => {
    expect(checkoutIdempotencyKey(base)).toBe(checkoutIdempotencyKey(base));
  });

  it("uses different keys for different plans or prices", () => {
    expect(
      checkoutIdempotencyKey({ ...base, plan: "standard" })
    ).not.toBe(checkoutIdempotencyKey(base));
    expect(
      checkoutIdempotencyKey({ ...base, priceId: "price_lite_next" })
    ).not.toBe(checkoutIdempotencyKey(base));
  });

  it("does not expose the user ID in the Stripe idempotency key", () => {
    const key = checkoutIdempotencyKey(base);

    expect(key).toMatch(/^sajikagen-checkout-v1-[a-f0-9]{64}$/);
    expect(key).not.toContain(base.userId);
  });
});
