import { describe, expect, it } from "vitest";

import {
  demoRouteErrorDiagnostic,
  demoRouteErrorMessage,
  isDemoTimeout,
} from "./demoRouteError";

describe("demoRouteErrorMessage", () => {
  it("returns fixed Japanese guidance for generation failures", () => {
    expect(demoRouteErrorMessage("generation")).toBe(
      "回答を作成できませんでした。時間をおいて、もう一度お試しください。"
    );
  });

  it("returns fixed Japanese guidance for timeouts and unexpected failures", () => {
    expect(demoRouteErrorMessage("timeout")).toContain("少し時間をおいて");
    expect(demoRouteErrorMessage("unexpected")).toContain("時間をおいて");
  });
});

describe("demoRouteErrorDiagnostic", () => {
  it("keeps only non-sensitive diagnostic fields", () => {
    const diagnostic = demoRouteErrorDiagnostic({
      name: "OpenAIError",
      code: "rate_limit",
      type: "api_error",
      status: 429,
      request_id: "req_safe",
      message: "sk-secret user@example.com demo_device_attempts",
      cause: "private cause",
      stack: "private stack",
    });

    expect(diagnostic).toEqual({
      name: "OpenAIError",
      code: "rate_limit",
      type: "api_error",
      status: 429,
      request_id: "req_safe",
    });
    expect(JSON.stringify(diagnostic)).not.toContain("sk-secret");
    expect(JSON.stringify(diagnostic)).not.toContain("user@example.com");
    expect(JSON.stringify(diagnostic)).not.toContain("demo_device_attempts");
  });
});

describe("isDemoTimeout", () => {
  it("recognizes abort and timeout errors without exposing their message", () => {
    expect(isDemoTimeout({ name: "AbortError" })).toBe(true);
    expect(isDemoTimeout({ message: "request aborted" })).toBe(true);
    expect(isDemoTimeout({ cause: "DEMO_TIMEOUT" })).toBe(true);
    expect(isDemoTimeout(new Error("database failed"))).toBe(false);
  });
});
