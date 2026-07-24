import { describe, expect, it } from "vitest";
import { publicChatErrorDiagnostic, publicChatErrorMessage } from "./publicChatError";

describe("publicChatError", () => {
  it("returns fixed user-facing messages for every internal failure stage", () => {
    expect(publicChatErrorMessage("status")).toContain("利用状況");
    expect(publicChatErrorMessage("quota")).toContain("残り回数");
    expect(publicChatErrorMessage("generation")).toContain("回答");
    expect(publicChatErrorMessage("usage")).toContain("利用回数");
    expect(publicChatErrorMessage("unexpected")).toContain("処理");
  });

  it("does not include an internal error message in diagnostics", () => {
    const diagnostic = publicChatErrorDiagnostic({
      name: "PostgrestError",
      code: "PGRST999",
      status: 500,
      message: "relation private_table does not exist; token=secret",
      details: "private schema details",
    });

    expect(diagnostic).toEqual({
      name: "PostgrestError",
      code: "PGRST999",
      status: 500,
    });
    expect(JSON.stringify(diagnostic)).not.toContain("private_table");
    expect(JSON.stringify(diagnostic)).not.toContain("secret");
  });

  it("handles primitive and unknown-shaped failures without exposing their value", () => {
    expect(publicChatErrorDiagnostic("secret failure")).toEqual({ type: "string" });
    expect(publicChatErrorDiagnostic({ message: "secret failure" })).toEqual({ type: "object" });
  });
});
