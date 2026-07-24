import { describe, expect, it } from "vitest";

import { securityHeaders } from "./securityHeaders";

function asRecord(nodeEnv: string) {
  return Object.fromEntries(
    securityHeaders(nodeEnv).map(({ key, value }) => [key, value])
  );
}

describe("securityHeaders", () => {
  it("adds the common browser protections to every environment", () => {
    const headers = asRecord("development");

    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(headers["Permissions-Policy"]).toBe(
      "camera=(), microphone=(), geolocation=(), payment=()"
    );
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
  });

  it("adds HSTS only in production", () => {
    expect(asRecord("production")["Strict-Transport-Security"]).toBe(
      "max-age=31536000"
    );
    expect(asRecord("development")["Strict-Transport-Security"]).toBeUndefined();
    expect(asRecord("test")["Strict-Transport-Security"]).toBeUndefined();
  });

  it("returns a fresh array on every call", () => {
    const first = securityHeaders("production");
    first[0].value = "changed";

    expect(securityHeaders("production")[0].value).not.toBe("changed");
  });
});
