import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const routeSource = fs.readFileSync(
  path.join(process.cwd(), "app/api/demo-chat/route.ts"),
  "utf8"
);

describe("demo chat route safety", () => {
  it("uses fixed public messages for all server-side failures", () => {
    expect(routeSource).toContain('demoRouteErrorMessage("generation")');
    expect(routeSource).toContain('demoRouteErrorMessage("timeout")');
    expect(routeSource).toContain('demoRouteErrorMessage("unexpected")');
    expect(routeSource).not.toContain("AI returned empty response");
  });

  it("does not write the raw exception to the server log", () => {
    expect(routeSource).toContain("demoRouteErrorDiagnostic(e)");
    expect(routeSource).not.toMatch(/console\.error\(\s*["'][^"']*["']\s*,\s*e\s*\)/);
  });
});
