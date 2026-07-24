import { createClient } from "@supabase/supabase-js";

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
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
    throw Object.assign(new Error("Missing Authorization Bearer token"), {
      status: 401,
    });
  }

  const { data: userResult, error: userError } =
    await supabase.auth.getUser(token);
  if (userError || !userResult?.user?.id) {
    throw Object.assign(new Error("Invalid session"), { status: 401 });
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
    throw Object.assign(new Error("Forbidden (admin only)"), { status: 403 });
  }

  return { uid, email };
}

export function adminApiError(error: unknown): {
  message: string;
  status: number;
} {
  if (!(error instanceof Error)) {
    return { message: String(error), status: 500 };
  }

  const status = Number((error as Error & { status?: unknown }).status);
  return {
    message: error.message,
    status:
      Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500,
  };
}
