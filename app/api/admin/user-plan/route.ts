// app/api/admin/user-plan/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getPlan, isPlanKey } from "../../../lib1/planMaster";

export const runtime = "nodejs";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function adminSupabase() {
  const url = mustEnv("SUPABASE_URL");
  const serviceRole = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, serviceRole, { auth: { persistSession: false } });
}

function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

async function requireAdmin(
  req: Request,
  supabase: ReturnType<typeof adminSupabase>
): Promise<{ uid: string; email: string }> {
  const token = bearerToken(req);
  if (!token) throw Object.assign(new Error("Missing Authorization Bearer token"), { status: 401 });

  const { data: userRes, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userRes?.user) throw Object.assign(new Error("Invalid session"), { status: 401 });

  const uid = userRes.user.id;
  const email = (userRes.user.email ?? "").toLowerCase();
  if (!uid) throw Object.assign(new Error("No user id on session"), { status: 401 });
  if (!email) throw Object.assign(new Error("No email on session"), { status: 401 });

  const { data: adminRow, error: adminErr } = await supabase
    .from("users")
    .select("id, is_admin")
    .eq("id", uid)
    .maybeSingle();

  if (adminErr) throw adminErr;
  if (!adminRow?.is_admin) throw Object.assign(new Error(`Forbidden (admin only): ${email}`), { status: 403 });

  return { uid, email };
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

function apiError(error: unknown): { message: string; status: number } {
  if (error instanceof Error) {
    const status = Number((error as Error & { status?: unknown }).status);
    return {
      message: error.message,
      status: Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500,
    };
  }
  return { message: String(error), status: 500 };
}

export async function POST(req: Request) {
  try {
    const supabase = adminSupabase();
    await requireAdmin(req, supabase);

    const body = (await req.json().catch(() => null)) as { user_id?: string; plan?: string } | null;
    const user_id = String(body?.user_id ?? "").trim();
    const planRaw = String(body?.plan ?? "").trim().toLowerCase();

    if (!user_id) return NextResponse.json({ ok: false, error: "user_id required" }, { status: 400 });
    if (!isUuid(user_id)) return NextResponse.json({ ok: false, error: "user_id must be uuid" }, { status: 400 });
    if (!isPlanKey(planRaw)) {
      return NextResponse.json({ ok: false, error: `invalid plan: ${planRaw}` }, { status: 400 });
    }

    const monthly_quota = getPlan(planRaw).monthlyQuota;

    const { error } = await supabase
      .from("users")
      .update({ plan: planRaw, monthly_quota })
      .eq("id", user_id);

    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    const api = apiError(error);
    if (api.status >= 500) console.error("admin user-plan api error", error);
    return NextResponse.json({ ok: false, error: api.message }, { status: api.status });
  }
}
