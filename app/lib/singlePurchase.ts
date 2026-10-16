export type SinglePurchaseKey = "single_1" | "single_3";

export type SinglePurchaseDefinition = {
  key: SinglePurchaseKey;
  credits: 1 | 3;
  amount: 980 | 1980;
  label: string;
  envName: "PRICE_ID_SINGLE_1" | "PRICE_ID_SINGLE_3";
};

const SINGLE_PURCHASES: Record<SinglePurchaseKey, SinglePurchaseDefinition> = {
  single_1: {
    key: "single_1",
    credits: 1,
    amount: 980,
    label: "1回だけ相談する",
    envName: "PRICE_ID_SINGLE_1",
  },
  single_3: {
    key: "single_3",
    credits: 3,
    amount: 1980,
    label: "3回相談パック",
    envName: "PRICE_ID_SINGLE_3",
  },
};

export function isSinglePurchaseKey(value: unknown): value is SinglePurchaseKey {
  return value === "single_1" || value === "single_3";
}

export function getSinglePurchase(
  key: SinglePurchaseKey
): SinglePurchaseDefinition {
  return SINGLE_PURCHASES[key];
}

export function getSinglePurchasePriceId(key: SinglePurchaseKey): string {
  const definition = getSinglePurchase(key);
  const priceId = process.env[definition.envName]?.trim();
  if (!priceId) throw new Error(`Missing env: ${definition.envName}`);
  return priceId;
}

export function resolveSinglePurchaseByPriceId(
  priceId: string | null | undefined
): SinglePurchaseDefinition | null {
  if (!priceId) return null;

  return (
    (Object.values(SINGLE_PURCHASES).find(
      (definition) =>
        process.env[definition.envName]?.trim() === priceId
    ) as SinglePurchaseDefinition | undefined) ?? null
  );
}

export function listSinglePurchases(): SinglePurchaseDefinition[] {
  return Object.values(SINGLE_PURCHASES);
}

