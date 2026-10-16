import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...parts: string[]) =>
  readFileSync(join(process.cwd(), ...parts), "utf8");

describe("single credit payment and consumption safety", () => {
  const checkout = read("app", "api", "create-single-checkout", "route.ts");
  const webhook = read("app", "api", "stripe", "webhook", "route.ts");
  const chat = read("app", "api", "chat", "route.ts");
  const purchaseStatus = read(
    "app",
    "api",
    "single-credits",
    "purchase-status",
    "route.ts"
  );
  const success = read("app", "success", "page.tsx");
  const migration = read("docs", "sql", "20261016_single_credits.sql");

  it("uses payment mode and server-side Price ID environment variables", () => {
    expect(checkout).toContain('mode: "payment"');
    expect(checkout).toContain("getSinglePurchasePriceId");
    expect(checkout).not.toMatch(/price_[A-Za-z0-9]+/);
  });

  it("grants only paid known products through an idempotent ledger RPC", () => {
    expect(webhook).toContain('session.payment_status !== "paid"');
    expect(webhook).toContain("resolveSinglePurchaseByPriceId");
    expect(webhook).toContain('p_source_key: `stripe_checkout:${session.id}`');
    expect(webhook).toContain('rpc("grant_single_credits"');
    expect(migration).toContain("source_key text not null unique");
    expect(purchaseStatus).toContain('session.payment_status !== "paid"');
  });

  it("consumes after answer generation with an atomic balance guard", () => {
    expect(chat.indexOf("core.answer")).toBeLessThan(
      chat.indexOf('rpc("consume_single_credit"')
    );
    expect(migration).toContain("and balance > 0");
    expect(migration).toContain("check (balance >= 0)");
  });

  it("confirms the ledger grant before emitting the one-time purchase event", () => {
    expect(success.indexOf("/api/single-credits/purchase-status")).toBeLessThan(
      success.indexOf("trackOpenAIOrderCreatedOnce(")
    );
    expect(success).toContain('plan: "single_credit"');
    expect(success).toContain("trackOpenAISubscriptionCreatedOnce");
  });
});
