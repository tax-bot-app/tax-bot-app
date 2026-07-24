import { describe, expect, it } from "vitest";

import { resolvePortalCustomerAccess } from "./portalCustomerAccess";

describe("resolvePortalCustomerAccess", () => {
  it("uses the Stripe customer already linked to the authenticated user", () => {
    expect(resolvePortalCustomerAccess(" cus_existing ")).toEqual({
      kind: "existing_customer",
      customerId: "cus_existing",
    });
  });

  it.each([null, undefined, "", " "])(
    "does not create a Stripe customer when no customer is linked: %s",
    (stripeCustomerId) => {
      expect(resolvePortalCustomerAccess(stripeCustomerId)).toEqual({
        kind: "no_customer",
      });
    }
  );
});
