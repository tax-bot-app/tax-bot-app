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

async function requireAdmin(req: Request, supabase: ReturnType<typeof adminSupabase>) {
  const token = bearerToken(req);
  if (!token) throw Object.assign(new Error("Missing Authorization Bearer token"), { status: 401 });

  const { data: userRes, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userRes?.user) throw Object.assign(new Error("Invalid session"), { status: 401 });

  const uid = userRes.user.id;

  const { data: adminRow, error: adminErr } = await supabase
    .from("users")
    .select("id,is_admin")
    .eq("id", uid)
    .maybeSingle();

  if (adminErr) throw adminErr;
  if (!adminRow?.is_admin) throw Object.assign(new Error("Forbidden (admin only)"), { status: 403 });

  return { uid };
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}


export async function POST(req: Request) {
  try {
    const supabase = adminSupabase();
    await requireAdmin(req, supabase);

    const body = (await req.json().catch(() => null)) as { user_id?: string; email?: string } | null;
    const user_id = String(body?.user_id ?? "").trim();
    const email = String(body?.email ?? "").trim().toLowerCase();

    if (!user_id) return NextResponse.json({ ok: false, error: "user_id required" }, { status: 400 });
    if (!isUuid(user_id)) return NextResponse.json({ ok: false, error: "user_id must be uuid" }, { status: 400 });

    // 1) 既に public.users があるなら何もしない（idempotent）
    const { data: existing, error: e0 } = await supabase
      .from("users")
      .select("id,email,plan,monthly_quota,is_admin")
      .eq("id", user_id)
      .maybeSingle();
    if (e0) throw e0;

    if (existing?.id) {
      // email が空で、入力emailがあるなら補完だけはする（任意）
      if ((!existing.email || !String(existing.email).trim()) && email) {
        const { error: ePatch } = await supabase.from("users").update({ email }).eq("id", user_id);
        if (ePatch) throw ePatch;
      }
      return NextResponse.json({ ok: true, user_id, created: false });
    }

    // 2) 無ければ作成（初期free / quota=1）
    const { error: e2 } = await supabase.from("users").insert({
      id: user_id,
      email: email || null,
      plan: "free",
     monthly_quota: 1,
      is_admin: false,
    });
    if (e2) throw e2;

    return NextResponse.json({ ok: true, user_id, created: true });
  } catch (e: any) {
    const status = e?.status ?? 500;
    if (status >= 500) console.error("admin provision-user api error", e);
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status });
  }
}