import { describe, expect, it } from "vitest";

import { resolveCheckoutUserIdentity } from "./checkoutUserIdentity";

describe("resolveCheckoutUserIdentity", () => {
  it("prefers the authenticated user ID over email", () => {
    expect(
      resolveCheckoutUserIdentity({
        metadataUserId: "3BA8DC2A-720F-4E95-A04A-CF8B527C4F11",
        email: " New-Address@Example.COM ",
      })
    ).toEqual({
      kind: "user_id",
      userId: "3ba8dc2a-720f-4e95-a04a-cf8b527c4f11",
      email: "new-address@example.com",
    });
  });

  it("uses email only for legacy Checkout sessions without user metadata", () => {
    expect(
      resolveCheckoutUserIdentity({
        metadataUserId: null,
        email: " Legacy@Example.COM ",
      })
    ).toEqual({
      kind: "legacy_email",
      email: "legacy@example.com",
    });
  });

  it("does not fall back to email when user metadata is present but invalid", () => {
    expect(
      resolveCheckoutUserIdentity({
        metadataUserId: "not-a-user-id",
        email: "customer@example.com",
      })
    ).toEqual({
      kind: "unresolved",
      reason: "invalid_user_id",
    });
  });

  it("reports a missing identity when neither user ID nor email is available", () => {
    expect(
      resolveCheckoutUserIdentity({
        metadataUserId: null,
        email: " ",
      })
    ).toEqual({
      kind: "unresolved",
      reason: "missing_identity",
    });
  });
});
