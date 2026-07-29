import { createClient } from "@supabase/supabase-js";

type AdminAuthorizationStatus = 401 | 403;

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

function adminAuthorizationError(
  message: string,
  status: AdminAuthorizationStatus
): Error {
  return Object.assign(new Error(message), {
    status,
    safeAdminAuthorizationError: true,
  });
}

export function createAdminSupabase() {
  return createClient(
    mustEnv("SUPABASE_URL"),
    mustEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } }
  );
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;

  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export async function requireAdmin(
  req: Request,
  supabase: ReturnType<typeof createAdminSupabase>
): Promise<{ uid: string; email: string | null }> {
  const token = bearerToken(req);
  if (!token) {
    throw adminAuthorizationError("Missing Authorization Bearer token", 401);
  }

  const { data: userResult, error: userError } =
    await supabase.auth.getUser(token);
  if (userError || !userResult?.user?.id) {
    throw adminAuthorizationError("Invalid session", 401);
  }

  const uid = userResult.user.id;
  const email = userResult.user.email?.trim().toLowerCase() || null;
  const { data: adminRow, error: adminError } = await supabase
    .from("users")
    .select("is_admin")
    .eq("id", uid)
    .maybeSingle();

  if (adminError) throw adminError;
  if (adminRow?.is_admin !== true) {
    throw adminAuthorizationError("Forbidden (admin only)", 403);
  }

  return { uid, email };
}

export function adminApiError(error: unknown): {
  message: string;
  status: number;
} {
  const status =
    error instanceof Error
      ? Number((error as Error & { status?: unknown }).status)
      : 500;

  const safeAuthorizationError =
    error instanceof Error &&
    (error as Error & { safeAdminAuthorizationError?: unknown })
      .safeAdminAuthorizationError === true;

  if (
    error instanceof Error &&
    safeAuthorizationError &&
    (status === 401 || status === 403)
  ) {
    return { message: error.message, status };
  }

  return {
    message:
      "管理機能の処理を完了できませんでした。時間をおいて、もう一度お試しください。",
    status: 500,
  };
}

export function adminApiErrorDiagnostic(
  error: unknown
): Record<string, string | number> {
  if (!error || typeof error !== "object") {
    return { type: typeof error };
  }

  const source = error as Record<string, unknown>;
  const diagnostic: Record<string, string | number> = {};

  for (const key of ["name", "code", "type", "status", "request_id"]) {
    const value = source[key];
    if (typeof value === "string" && value) {
      diagnostic[key] = value.slice(0, 120);
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      diagnostic[key] = value;
    }
  }

  return Object.keys(diagnostic).length > 0
    ? diagnostic
    : { type: "object" };
}
