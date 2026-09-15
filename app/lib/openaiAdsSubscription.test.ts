import { describe, expect, it } from "vitest";

import {
  isConfirmedSubscription,
  subscriptionConversionId,
} from "./openaiAdsSubscription";

describe("OpenAI Ads subscription confirmation", () => {
  it.each(["active", "trialing"])(
    "accepts a completed %s subscription",
    (subscriptionStatus) => {
      expect(
        isConfirmedSubscription({
          checkoutMode: "subscription",
          checkoutStatus: "complete",
          subscriptionStatus,
        })
      ).toBe(true);
    }
  );

  it.each(["incomplete", "past_due", "unpaid", "canceled", null])(
    "rejects subscription status %s",
    (subscriptionStatus) => {
      expect(
        isConfirmedSubscription({
          checkoutMode: "subscription",
          checkoutStatus: "complete",
          subscriptionStatus,
        })
      ).toBe(false);
    }
  );

  it("rejects an incomplete Checkout Session", () => {
    expect(
      isConfirmedSubscription({
        checkoutMode: "subscription",
        checkoutStatus: "open",
        subscriptionStatus: "active",
      })
    ).toBe(false);
  });

  it("creates a stable opaque conversion id", () => {
    const id = subscriptionConversionId("cs_test_example");
    expect(id).toBe(subscriptionConversionId("cs_test_example"));
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    expect(id).not.toContain("cs_test_example");
  });
});

