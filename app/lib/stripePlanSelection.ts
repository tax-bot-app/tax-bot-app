import {
  getPlan,
  getPlanByPriceId,
  normalizePlanKey,
  type PlanKey,
} from "../lib1/planMaster";

export type StripeSubscriptionSnapshot = {
  id: string;
  status: string;
  priceIds: Array<string | null>;
  currentPeriodEnd: number;
  created: number;
};

export type StripePlanSelection =
  | { kind: "free" }
  | {
      kind: "selected";
      plan: PlanKey;
      subscriptionId: string;
    }
  | {
      kind: "unresolved";
      activeSubscriptionIds: string[];
    };

export function selectBestStripePlan(
  subscriptions: StripeSubscriptionSnapshot[]
): StripePlanSelection {
  const active = subscriptions.filter((subscription) =>
    ["active", "trialing"].includes(subscription.status)
  );

  if (active.length === 0) return { kind: "free" };

  const resolved = active
    .map((subscription) => {
      let bestPlan: PlanKey | null = null;

      for (const priceId of subscription.priceIds) {
        const planDefinition = getPlanByPriceId(priceId);
        if (!planDefinition) continue;

        const plan = normalizePlanKey(planDefinition.key);
        if (
          !bestPlan ||
          getPlan(plan).sortOrder > getPlan(bestPlan).sortOrder
        ) {
          bestPlan = plan;
        }
      }

      if (!bestPlan) return null;

      return {
        subscription,
        plan: bestPlan,
        sortOrder: getPlan(bestPlan).sortOrder,
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> =>
      Boolean(candidate)
    );

  if (resolved.length === 0) {
    return {
      kind: "unresolved",
      activeSubscriptionIds: active.map((subscription) => subscription.id),
    };
  }

  resolved.sort((a, b) => {
    if (b.sortOrder !== a.sortOrder) return b.sortOrder - a.sortOrder;
    if (b.subscription.currentPeriodEnd !== a.subscription.currentPeriodEnd) {
      return (
        b.subscription.currentPeriodEnd - a.subscription.currentPeriodEnd
      );
    }
    return b.subscription.created - a.subscription.created;
  });

  const best = resolved[0];
  return {
    kind: "selected",
    plan: best.plan,
    subscriptionId: best.subscription.id,
  };
}
