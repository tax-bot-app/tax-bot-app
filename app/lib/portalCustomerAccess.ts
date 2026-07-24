export type PortalCustomerAccess =
  | { kind: "existing_customer"; customerId: string }
  | { kind: "no_customer" };

export function resolvePortalCustomerAccess(
  stripeCustomerId: string | null | undefined
): PortalCustomerAccess {
  const customerId = stripeCustomerId?.trim() ?? "";

  return customerId
    ? { kind: "existing_customer", customerId }
    : { kind: "no_customer" };
}
