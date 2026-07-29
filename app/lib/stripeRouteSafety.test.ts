import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const route = (...parts: string[]) =>
  readFileSync(join(process.cwd(), "app", "api", ...parts, "route.ts"), "utf8");

describe("Stripe route error and log safety", () => {
  const checkout = route("create-checkout");
  const portal = route("stripe", "portal");
  const webhook = route("stripe", "webhook");

  it("does not return caught internal errors from Checkout or Portal", () => {
    expect(checkout).toMatch(/stripeRouteErrorMessage\("checkout"\)/);
    expect(portal).toMatch(/stripeRouteErrorMessage\("portal"\)/);
    expect(checkout).not.toMatch(/error:\s*(?:message|errorMessage\(e\))/);
    expect(portal).not.toMatch(/error:\s*(?:message|errorMessage\(e\))/);
  });

  it("does not return raw Webhook verification or handler errors", () => {
    expect(webhook).not.toContain("Webhook signature verification failed:");
    expect(webhook).not.toMatch(/error:\s*errorMessage\(e\)/);
    expect(webhook).toMatch(/stripeRouteErrorMessage\("webhook"\)/);
  });

  it("does not write Stripe identifiers, email, or raw errors to logs", () => {
    const logCalls =
      webhook.match(/console\.(?:log|warn|error)\([\s\S]*?\);/g) ?? [];
    const serialized = logCalls.join("\n");

    for (const sensitiveName of [
      "customerId",
      "subscriptionId",
      "sessionId",
      "userId",
      "email",
      "priceId",
      "eventId",
    ]) {
      expect(serialized).not.toContain(sensitiveName);
    }

    expect(serialized).not.toMatch(/console\.(?:warn|error)\([^;]*,\s*e\s*\)/);
    expect(serialized).not.toContain("error.message");
  });
});
