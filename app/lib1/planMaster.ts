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
   * - paid plans: resolved via ENV (test/live separated by environment)
   */
  priceIds: string[];

  /** For UI display / ranking (higher = stronger plan) */
  sortOrder: number;
};

function envOptional(name: string): string | null {
  const v = process.env[name];
  const t = typeof v === "string" ? v.trim() : "";
  return t ? t : null;
}

function envRequired(name: string): string {
  const v = envOptional(name);
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

/**
 * Plan -> Stripe PriceId（test/live は Vercel 環境で分離）
 * ENV names:
 * - PRICE_ID_LITE
 * - PRICE_ID_STANDARD
 * - PRICE_ID_ENTERPRISE
 */
const PRICE_ID_BY_PLAN: Partial<Record<Exclude<PlanKey, "free">, string>> = {
  lite: envOptional("PRICE_ID_LITE") ?? undefined,
  standard: envOptional("PRICE_ID_STANDARD") ?? undefined,
  enterprise: envOptional("PRICE_ID_ENTERPRISE") ?? undefined,
};

export function getPriceId(planKey: PlanKey): string {
  if (planKey === "free") throw new Error("free has no priceId");

  const id = PRICE_ID_BY_PLAN[planKey as Exclude<PlanKey, "free">];
  if (id) return id;

  // fallback (still ENV-driven; gives clearer error)
  return envRequired(`PRICE_ID_${String(planKey).toUpperCase()}`);
}

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
    // ✅ Stripe priceId is ENV-driven
    priceIds: [],
    sortOrder: 1,
  },

  standard: {
    key: "standard",
    label: "Standard",
    monthlyQuota: 30,
    // ✅ Stripe priceId is ENV-driven
    priceIds: [],
    sortOrder: 2,
  },

  enterprise: {
    key: "enterprise",
    label: "Enterprise",
    monthlyQuota: 100,
    // ✅ Stripe priceId is ENV-driven
    priceIds: [],
    sortOrder: 3,
  },
} as const;

/** Get plan definition by planKey (always returns). */
export function getPlan(planKey: PlanKey): PlanDefinition {
  return PLAN_MASTER[planKey];
}

/** Get plan definition by Stripe priceId (returns null if unknown). */
export function getPlanByPriceId(priceId: string | null | undefined): PlanDefinition | null {
  if (!priceId) return null;

  const liteNow = envOptional("PRICE_ID_LITE");
  const liteLegacy = envOptional("PRICE_ID_LITE_LEGACY");
  const liteNext = envOptional("PRICE_ID_LITE_NEXT");
  const standardNow = envOptional("PRICE_ID_STANDARD");
  const standardLegacy = envOptional("PRICE_ID_STANDARD_LEGACY");
  const standardNext = envOptional("PRICE_ID_STANDARD_NEXT");
  const enterpriseNow = envOptional("PRICE_ID_ENTERPRISE");
  const enterpriseLegacy = envOptional("PRICE_ID_ENTERPRISE_LEGACY");
  const enterpriseNext = envOptional("PRICE_ID_ENTERPRISE_NEXT");

  // ✅ Lite は「現行 + 旧」を両方 lite 扱いにする
  if (
    (liteNow && priceId === liteNow) ||
    (liteLegacy && priceId === liteLegacy) ||
    (liteNext && priceId === liteNext)
  ) {
    return getPlan("lite");
  }

  // ✅ Standard は「現行 + 旧」を両方 standard 扱いにする
  if (
    (standardNow && priceId === standardNow) ||
    (standardLegacy && priceId === standardLegacy) ||
    (standardNext && priceId === standardNext)
  ) {
    return getPlan("standard");
  }

  // ✅ Enterprise も「現行 + 旧」を両方 enterprise 扱いにする
  if (
    (enterpriseNow && priceId === enterpriseNow) ||
    (enterpriseLegacy && priceId === enterpriseLegacy) ||
    (enterpriseNext && priceId === enterpriseNext)
  ) {
    return getPlan("enterprise");
  }

  // ✅ 不明 priceId は null（freeに丸めない）
  return null;
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
  return value === "free" || value === "lite" || value === "standard" || value === "enterprise";
}

/**
 * Resolve plan from DB record (plan column) safely.
 * - unknown/empty -> "free"
 */
export function normalizePlanKey(value: unknown): PlanKey {
  if (isPlanKey(value)) return value;
  return "free";
}