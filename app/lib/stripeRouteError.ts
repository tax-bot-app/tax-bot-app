export type StripeRouteErrorKind = "checkout" | "portal" | "webhook";

const PUBLIC_MESSAGES: Record<StripeRouteErrorKind, string> = {
  checkout:
    "決済画面を準備できませんでした。時間をおいて、もう一度お試しください。",
  portal:
    "請求情報を開けませんでした。時間をおいて、もう一度お試しください。",
  webhook: "Webhook processing failed",
};

export function stripeRouteErrorMessage(kind: StripeRouteErrorKind): string {
  return PUBLIC_MESSAGES[kind];
}

export function stripeRouteErrorDiagnostic(
  error: unknown
): Record<string, string | number> {
  if (!error || typeof error !== "object") {
    return { type: typeof error };
  }

  const source = error as Record<string, unknown>;
  const diagnostic: Record<string, string | number> = {};

  for (const key of ["name", "code", "type", "status", "request_id"]) {
    const value = source[key];
    if (typeof value === "string" && value) diagnostic[key] = value.slice(0, 120);
    if (typeof value === "number" && Number.isFinite(value)) diagnostic[key] = value;
  }

  return Object.keys(diagnostic).length > 0 ? diagnostic : { type: "object" };
}
