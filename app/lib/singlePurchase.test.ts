import { afterEach, describe, expect, it } from "vitest";

import {
  getSinglePurchase,
  isSinglePurchaseKey,
  resolveSinglePurchaseByPriceId,
} from "./singlePurchase";

const originalSingle1 = process.env.PRICE_ID_SINGLE_1;
const originalSingle3 = process.env.PRICE_ID_SINGLE_3;

afterEach(() => {
  process.env.PRICE_ID_SINGLE_1 = originalSingle1;
  process.env.PRICE_ID_SINGLE_3 = originalSingle3;
});

describe("single purchase definitions", () => {
  it("defines the confirmed products", () => {
    expect(getSinglePurchase("single_1")).toMatchObject({
      credits: 1,
      amount: 980,
      envName: "PRICE_ID_SINGLE_1",
    });
    expect(getSinglePurchase("single_3")).toMatchObject({
      credits: 3,
      amount: 1980,
      envName: "PRICE_ID_SINGLE_3",
    });
  });

  it("accepts only the two purchase keys", () => {
    expect(isSinglePurchaseKey("single_1")).toBe(true);
    expect(isSinglePurchaseKey("single_3")).toBe(true);
    expect(isSinglePurchaseKey("lite")).toBe(false);
  });

  it("maps Stripe Price IDs without treating monthly prices as credits", () => {
    process.env.PRICE_ID_SINGLE_1 = "price_single_1";
    process.env.PRICE_ID_SINGLE_3 = "price_single_3";

    expect(resolveSinglePurchaseByPriceId("price_single_1")?.credits).toBe(1);
    expect(resolveSinglePurchaseByPriceId("price_single_3")?.credits).toBe(3);
    expect(resolveSinglePurchaseByPriceId("price_monthly")).toBeNull();
  });
});

