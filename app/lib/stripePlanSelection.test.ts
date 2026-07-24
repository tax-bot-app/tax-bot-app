import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  selectBestStripePlan,
  type StripeSubscriptionSnapshot,
} from "./stripePlanSelection";

function subscription(
  overrides: Partial<StripeSubscriptionSnapshot> = {}
): StripeSubscriptionSnapshot {
  return {
    id: "sub_default",
    status: "active",
    priceIds: ["price_lite"],
    currentPeriodEnd: 100,
    created: 10,
    ...overrides,
  };
}

const priceEnvNames = [
  "PRICE_ID_LITE",
  "PRICE_ID_LITE_LEGACY",
  "PRICE_ID_LITE_NEXT",
  "PRICE_ID_STANDARD",
  "PRICE_ID_STANDARD_LEGACY",
  "PRICE_ID_STANDARD_NEXT",
  "PRICE_ID_ENTERPRISE",
  "PRICE_ID_ENTERPRISE_LEGACY",
  "PRICE_ID_ENTERPRISE_NEXT",
] as const;

describe("selectBestStripePlan", () => {
  const originalEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of priceEnvNames) {
      originalEnv.set(name, process.env[name]);
      delete process.env[name];
    }

    process.env.PRICE_ID_LITE_NEXT = "price_lite";
    process.env.PRICE_ID_STANDARD_NEXT = "price_standard";
    process.env.PRICE_ID_ENTERPRISE_NEXT = "price_enterprise";
    process.env.PRICE_ID_ENTERPRISE_LEGACY = "price_enterprise_legacy";
  });

  afterEach(() => {
    for (const name of priceEnvNames) {
      const original = originalEnv.get(name);
      if (original === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = original;
      }
    }
    originalEnv.clear();
  });

  it("selects free when there is no active or trialing subscription", () => {
    const result = selectBestStripePlan([
      subscription({ status: "canceled" }),
      subscription({ id: "sub_past_due", status: "past_due" }),
    ]);

    expect(result).toEqual({ kind: "free" });
  });

  it("selects the strongest plan across multiple active subscriptions", () => {
    const result = selectBestStripePlan([
      subscription({ id: "sub_lite" }),
      subscription({
        id: "sub_enterprise",
        priceIds: ["price_enterprise"],
      }),
      subscription({
        id: "sub_standard",
        status: "trialing",
        priceIds: ["price_standard"],
      }),
    ]);

    expect(result).toEqual({
      kind: "selected",
      plan: "enterprise",
      subscriptionId: "sub_enterprise",
    });
  });

  it("recognizes a legacy price ID", () => {
    const result = selectBestStripePlan([
      subscription({
        id: "sub_legacy",
        priceIds: ["price_enterprise_legacy"],
      }),
    ]);

    expect(result).toEqual({
      kind: "selected",
      plan: "enterprise",
      subscriptionId: "sub_legacy",
    });
  });

  it("does not downgrade to free when all active price IDs are unknown", () => {
    const result = selectBestStripePlan([
      subscription({ id: "sub_unknown", priceIds: ["price_unknown"] }),
    ]);

    expect(result).toEqual({
      kind: "unresolved",
      activeSubscriptionIds: ["sub_unknown"],
    });
  });

  it("ignores an unknown subscription when another active plan resolves", () => {
    const result = selectBestStripePlan([
      subscription({ id: "sub_unknown", priceIds: ["price_unknown"] }),
      subscription({ id: "sub_lite" }),
    ]);

    expect(result).toEqual({
      kind: "selected",
      plan: "lite",
      subscriptionId: "sub_lite",
    });
  });

  it("uses period end and then creation time to break equal-plan ties", () => {
    const laterPeriod = selectBestStripePlan([
      subscription({
        id: "sub_older_period",
        currentPeriodEnd: 100,
        created: 30,
      }),
      subscription({
        id: "sub_later_period",
        currentPeriodEnd: 200,
        created: 10,
      }),
    ]);

    expect(laterPeriod).toMatchObject({
      kind: "selected",
      subscriptionId: "sub_later_period",
    });

    const laterCreated = selectBestStripePlan([
      subscription({ id: "sub_older", currentPeriodEnd: 200, created: 10 }),
      subscription({ id: "sub_newer", currentPeriodEnd: 200, created: 20 }),
    ]);

    expect(laterCreated).toMatchObject({
      kind: "selected",
      subscriptionId: "sub_newer",
    });
  });
});
