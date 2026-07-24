import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function adminRouteFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return adminRouteFiles(path);
    return entry.isFile() && entry.name === "route.ts" ? [path] : [];
  });
}

describe("admin route authorization", () => {
  it("requires the shared admin authorization on every admin API route", () => {
    const root = join(process.cwd(), "app", "api", "admin");
    const routes = adminRouteFiles(root);

    expect(routes.length).toBeGreaterThan(0);

    for (const route of routes) {
      const source = readFileSync(route, "utf8");
      expect(source, route).toMatch(/\brequireAdmin\s*\(/);
      expect(source, route).toMatch(/from\s+["'][^"']*lib\/adminAccess["']/);
    }
  });
});
