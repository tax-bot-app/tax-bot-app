import { createHash } from "crypto";

const CONFIRMED_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

export function isConfirmedSubscription(params: {
  checkoutMode: string | null;
  checkoutStatus: string | null;
  subscriptionStatus: string | null;
}): boolean {
  return (
    params.checkoutMode === "subscription" &&
    params.checkoutStatus === "complete" &&
    Boolean(
      params.subscriptionStatus &&
        CONFIRMED_SUBSCRIPTION_STATUSES.has(params.subscriptionStatus)
    )
  );
}

export function subscriptionConversionId(sessionId: string): string {
  return createHash("sha256").update(sessionId, "utf8").digest("hex");
}

