export type CheckoutUserIdentity =
  | { kind: "user_id"; userId: string; email: string | null }
  | { kind: "legacy_email"; email: string }
  | { kind: "unresolved"; reason: "invalid_user_id" | "missing_identity" };

export type ResolvedCheckoutUserIdentity = Exclude<
  CheckoutUserIdentity,
  { kind: "unresolved" }
>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeEmail(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase() ?? "";
  return normalized || null;
}

export function resolveCheckoutUserIdentity(params: {
  metadataUserId: string | null | undefined;
  email: string | null | undefined;
}): CheckoutUserIdentity {
  const metadataUserId = params.metadataUserId?.trim() ?? "";
  const email = normalizeEmail(params.email);

  if (metadataUserId) {
    if (!UUID_PATTERN.test(metadataUserId)) {
      return { kind: "unresolved", reason: "invalid_user_id" };
    }

    return {
      kind: "user_id",
      userId: metadataUserId.toLowerCase(),
      email,
    };
  }

  if (email) {
    return { kind: "legacy_email", email };
  }

  return { kind: "unresolved", reason: "missing_identity" };
}
