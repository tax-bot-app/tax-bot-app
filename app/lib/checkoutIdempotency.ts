import { createHash } from "node:crypto";

import type { PlanKey } from "../lib1/planMaster";

export function checkoutIdempotencyKey(params: {
  userId: string;
  plan: Exclude<PlanKey, "free">;
  priceId: string;
}): string {
  const digest = createHash("sha256")
    .update(`${params.userId}\0${params.plan}\0${params.priceId}`)
    .digest("hex");

  return `sajikagen-checkout-v1-${digest}`;
}
