import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("public chat route error safety", () => {
  const source = readFileSync(
    join(process.cwd(), "app", "api", "chat", "route.ts"),
    "utf8"
  );

  it("does not return the usage RPC name to the browser", () => {
    expect(source).not.toContain('error: "consume_talk_v2: empty result"');
    expect(source).toMatch(
      /usage-empty-result[\s\S]*publicChatErrorMessage\("usage"\)/
    );
  });

  it("does not write full chat traces or raw caught errors to server logs", () => {
    expect(source).not.toContain("[chat-trace]");
    expect(source).not.toMatch(
      /console\.error\(\s*"\[(?:guardrail:block persist failed|messages-insert-failed)\]"\s*,\s*e\s*\)/
    );
    expect(source).toMatch(
      /guardrail:block-persist-failed[\s\S]*publicChatErrorDiagnostic\(e\)/
    );
    expect(source).toMatch(
      /chat:messages-insert-failed[\s\S]*publicChatErrorDiagnostic\(e\)/
    );
  });
});
