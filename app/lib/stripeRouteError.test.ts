import { describe, expect, it } from "vitest";
import {
  stripeRouteErrorDiagnostic,
  stripeRouteErrorMessage,
} from "./stripeRouteError";

describe("stripeRouteError", () => {
  it("returns fixed messages without internal details", () => {
    expect(stripeRouteErrorMessage("checkout")).toContain("決済画面");
    expect(stripeRouteErrorMessage("portal")).toContain("請求情報");
    expect(stripeRouteErrorMessage("webhook")).toBe("Webhook processing failed");
  });

  it("keeps only safe diagnostic fields", () => {
    const diagnostic = stripeRouteErrorDiagnostic({
      name: "StripeError",
      code: "api_connection_error",
      status: 500,
      request_id: "req_safe",
      message: "customer cus_private email=user@example.com",
      raw: { token: "secret" },
    });

    expect(diagnostic).toEqual({
      name: "StripeError",
      code: "api_connection_error",
      status: 500,
      request_id: "req_safe",
    });
    expect(JSON.stringify(diagnostic)).not.toContain("cus_private");
    expect(JSON.stringify(diagnostic)).not.toContain("user@example.com");
    expect(JSON.stringify(diagnostic)).not.toContain("secret");
  });

  it("does not expose primitive failure values", () => {
    expect(stripeRouteErrorDiagnostic("customer cus_private")).toEqual({
      type: "string",
    });
    expect(stripeRouteErrorDiagnostic({ message: "private table" })).toEqual({
      type: "object",
    });
  });
});
