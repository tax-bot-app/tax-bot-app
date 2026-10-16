import { describe, expect, it } from "vitest";
import { chooseChatCreditSource } from "./chatCreditSource";

describe("chooseChatCreditSource", () => {
  it("prioritizes monthly usage when both sources are available", () => {
    expect(
      chooseChatCreditSource({ monthlyAvailable: true, singleCredits: 3 })
    ).toBe("monthly");
  });

  it("uses a single credit when monthly usage is unavailable", () => {
    expect(
      chooseChatCreditSource({ monthlyAvailable: false, singleCredits: 1 })
    ).toBe("single");
  });

  it("rejects access when neither source is available", () => {
    expect(
      chooseChatCreditSource({ monthlyAvailable: false, singleCredits: 0 })
    ).toBe("none");
  });
});
