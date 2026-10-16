import { createHash } from "crypto";

import type { SinglePurchaseKey } from "./singlePurchase";

export function singleCheckoutIdempotencyKey(params: {
  userId: string;
  purchase: SinglePurchaseKey;
  priceId: string;
  attemptId: string;
}): string {
  const digest = createHash("sha256")
    .update(
      `${params.userId}\0${params.purchase}\0${params.priceId}\0${params.attemptId}`
    )
    .digest("hex");

  return `sajikagen-single-checkout-v1-${digest}`;
}

