import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

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
  if (!token) {
    throw Object.assign(new Error("Missing Authorization Bearer token"), { status: 401 });
  }

  const { data: userRes, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userRes?.user) {
    throw Object.assign(new Error("Invalid session"), { status: 401 });
  }

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

  if (!adminRow?.is_admin) {
    throw Object.assign(new Error(`Forbidden (admin only): ${email}`), { status: 403 });
  }

  return { uid, email };
}

export async function GET(req: Request) {
  try {
    const supabase = adminSupabase();
    await requireAdmin(req, supabase);

    const { searchParams } = new URL(req.url);
    const month = searchParams.get("month") ?? new Date().toISOString().slice(0, 7);

    const { data, error } = await supabase
      .from("usage")
      .select(
        `
        user_id,
        month,
        used_talks,
        limit_talks,
        updated_at,
        users:users (
          email,
          plan,
          monthly_quota,
          is_admin
        )
      `
      )
      .eq("month", month)
      .order("updated_at", { ascending: false });

    if (error) throw error;

    return NextResponse.json({ ok: true, data });
  } catch (e: any) {
    const status = e?.status ?? 500;
    if (status >= 500) console.error("admin usage api error", e);

    return NextResponse.json(
      { ok: false, error: e?.message ?? String(e) },
      { status }
    );
  }
}
