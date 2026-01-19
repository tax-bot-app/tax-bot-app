// app/lib1/planMaster.ts
// ✅ Single source of truth for plans (UI / webhook / DB / future pricing)

export type PlanKey = "free" | "lite" | "standard" | "enterprise";

export type PlanDefinition = {
  key: PlanKey;
  label: string;
  monthlyQuota: number;

  /**
   * Stripe price IDs mapped to this plan.
   * - free: []
   * - paid plans: one or more price IDs (future-proof for price changes)
   */
  priceIds: string[];

  /** For UI display / ranking (higher = stronger plan) */
  sortOrder: number;
};

export const PLAN_MASTER: Record<PlanKey, PlanDefinition> = {
  free: {
    key: "free",
    label: "Free",
    monthlyQuota: 0,
    priceIds: [],
    sortOrder: 0,
  },

  lite: {
    key: "lite",
    label: "Lite",
    monthlyQuota: 5,
    // ✅ Stripe test mode priceId
    priceIds: ["price_1SmqJoQ3OyVaMed9QdAkDBzA"],
    sortOrder: 1,
  },

  standard: {
    key: "standard",
    label: "Standard",
    monthlyQuota: 30,
    // ✅ Stripe test mode priceId
    priceIds: ["price_1Sm8qnQ3OyVaMed9WMDOPgLZ"],
    sortOrder: 2,
  },

  enterprise: {
    key: "enterprise",
    label: "Enterprise",
    monthlyQuota: 100,
    // ✅ Stripe test mode priceId
    priceIds: ["price_1Smq2QQ3OyVaMed9uh5CgQfD"],
    sortOrder: 3,
  },
} as const;

/** Get plan definition by planKey (always returns). */
export function getPlan(planKey: PlanKey): PlanDefinition {
  return PLAN_MASTER[planKey];
}

/** Get plan definition by Stripe priceId (returns null if unknown). */
export function getPlanByPriceId(
  priceId: string | null | undefined
): PlanDefinition | null {
  if (!priceId) return null;

  const hit =
    Object.values(PLAN_MASTER).find((p) => p.priceIds.includes(priceId)) ?? null;

  // free has no priceIds by design
  if (hit?.key === "free") return null;

  return hit;
}

/** Ordered plans for UI display (includes free by default). */
export function listPlans(options?: { includeFree?: boolean }): PlanDefinition[] {
  const includeFree = options?.includeFree ?? true;

  return Object.values(PLAN_MASTER)
    .filter((p) => (includeFree ? true : p.key !== "free"))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/** For UI cards (paid only). */
export function listPaidPlans(): PlanDefinition[] {
  return listPlans({ includeFree: false });
}

/** Type guard */
export function isPlanKey(value: unknown): value is PlanKey {
  return (
    value === "free" ||
    value === "lite" ||
    value === "standard" ||
    value === "enterprise"
  );
}

/**
 * Resolve plan from DB record (plan column) safely.
 * - unknown/empty -> "free"
 */
export function normalizePlanKey(value: unknown): PlanKey {
  if (isPlanKey(value)) return value;
  return "free";
}
