import { describe, expect, it } from "vitest";

import { validateSiteOrigin } from "./siteOrigin";

describe("site origin", () => {
  it("keeps only the configured origin", () => {
    expect(validateSiteOrigin("https://example.com/path?x=1#hash", "production")).toBe(
      "https://example.com"
    );
  });

  it("allows http during local development", () => {
    expect(validateSiteOrigin("http://localhost:3000/path", "development")).toBe(
      "http://localhost:3000"
    );
  });

  it.each([
    [undefined, "Missing env: NEXT_PUBLIC_SITE_URL"],
    ["not-a-url", "Invalid NEXT_PUBLIC_SITE_URL"],
    ["ftp://example.com", "Invalid NEXT_PUBLIC_SITE_URL"],
    ["https://user:pass@example.com", "Invalid NEXT_PUBLIC_SITE_URL"],
    ["http://example.com", "NEXT_PUBLIC_SITE_URL must use https in production"],
  ])("rejects unsafe configuration: %s", (raw, message) => {
    expect(() => validateSiteOrigin(raw, "production")).toThrow(message);
  });
});
