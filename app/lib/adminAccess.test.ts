import { describe, expect, it, vi } from "vitest";

import {
  adminApiError,
  adminApiErrorDiagnostic,
  bearerToken,
  requireAdmin,
} from "./adminAccess";

type AdminClient = Parameters<typeof requireAdmin>[1];

function request(authorization?: string): Request {
  return new Request("https://example.com/api/admin/test", {
    headers: authorization ? { authorization } : undefined,
  });
}

function client(params?: {
  userId?: string | null;
  email?: string | null;
  userError?: Error | null;
  isAdmin?: boolean | null;
  adminError?: Error | null;
}): AdminClient {
  const maybeSingle = vi.fn().mockResolvedValue({
    data:
      params?.isAdmin === null
        ? null
        : { is_admin: params?.isAdmin ?? true },
    error: params?.adminError ?? null,
  });
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));

  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: {
          user:
            params?.userId === null
              ? null
              : {
                  id: params?.userId ?? "11111111-1111-4111-8111-111111111111",
                  email:
                    params && "email" in params
                      ? params.email
                      : "ADMIN@EXAMPLE.COM",
                },
        },
        error: params?.userError ?? null,
      }),
    },
    from: vi.fn(() => ({ select })),
  } as unknown as AdminClient;
}

describe("admin access", () => {
  it("extracts a trimmed bearer token case-insensitively", () => {
    expect(bearerToken(request("bearer   token-value  "))).toBe("token-value");
  });

  it("rejects a request without a bearer token", async () => {
    await expect(requireAdmin(request(), client())).rejects.toMatchObject({
      message: "Missing Authorization Bearer token",
      status: 401,
    });
  });

  it("rejects an invalid session", async () => {
    await expect(
      requireAdmin(
        request("Bearer token"),
        client({ userError: new Error("expired") })
      )
    ).rejects.toMatchObject({ message: "Invalid session", status: 401 });
  });

  it("rejects an authenticated non-admin user", async () => {
    await expect(
      requireAdmin(request("Bearer token"), client({ isAdmin: false }))
    ).rejects.toMatchObject({
      message: "Forbidden (admin only)",
      status: 403,
    });
  });

  it("authorizes strictly by authenticated user ID", async () => {
    const supabase = client({ email: null, isAdmin: true });

    await expect(
      requireAdmin(request("Bearer token"), supabase)
    ).resolves.toEqual({
      uid: "11111111-1111-4111-8111-111111111111",
      email: null,
    });

    expect(supabase.from).toHaveBeenCalledWith("users");
    expect(supabase.auth.getUser).toHaveBeenCalledWith("token");
  });

  it("preserves authorization errors and hides internal errors", () => {
    expect(
      adminApiError(
        Object.assign(new Error("Forbidden"), {
          status: 403,
          safeAdminAuthorizationError: true,
        })
      )
    ).toEqual({ message: "Forbidden", status: 403 });
    expect(
      adminApiError(Object.assign(new Error("database policy detail"), { status: 403 }))
    ).toEqual({
      message:
        "管理機能の処理を完了できませんでした。時間をおいて、もう一度お試しください。",
      status: 500,
    });
    expect(
      adminApiError(Object.assign(new Error("Bad status"), { status: 999 }))
    ).toEqual({
      message:
        "管理機能の処理を完了できませんでした。時間をおいて、もう一度お試しください。",
      status: 500,
    });
    expect(adminApiError(new Error("relation users does not exist"))).toEqual({
      message:
        "管理機能の処理を完了できませんでした。時間をおいて、もう一度お試しください。",
      status: 500,
    });
  });

  it("keeps only safe diagnostic fields", () => {
    const diagnostic = adminApiErrorDiagnostic({
      name: "PostgrestError",
      code: "42P01",
      status: 500,
      request_id: "req_123",
      message: "relation users does not exist",
      stack: "secret stack",
      details: "sensitive details",
    });

    expect(diagnostic).toEqual({
      name: "PostgrestError",
      code: "42P01",
      status: 500,
      request_id: "req_123",
    });
    expect(JSON.stringify(diagnostic)).not.toContain("relation users");
    expect(JSON.stringify(diagnostic)).not.toContain("secret stack");
  });
});
