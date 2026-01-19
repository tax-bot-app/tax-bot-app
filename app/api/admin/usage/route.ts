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

export async function GET(req: Request) {
  try {
    const token = bearerToken(req);
    if (!token) {
      return NextResponse.json(
        { ok: false, error: "Missing Authorization Bearer token" },
        { status: 401 }
      );
    }

    const supabase = adminSupabase();

    // ① token からログインユーザー特定（email / id）
    const { data: userRes, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userRes?.user) {
      return NextResponse.json(
        { ok: false, error: "Invalid session" },
        { status: 401 }
      );
    }

    const email = (userRes.user.email ?? "").toLowerCase();
    if (!email) {
      return NextResponse.json(
        { ok: false, error: "No email on session" },
        { status: 401 }
      );
    }

    // ② public.users を見て is_admin 判定（ここが唯一の権限判定）
    const { data: adminRow, error: adminErr } = await supabase
      .from("users")
      .select("email, is_admin")
      .eq("email", email)
      .maybeSingle();

    if (adminErr) throw adminErr;

    if (!adminRow?.is_admin) {
      // どのemailで弾かれたか分かるように返す（デバッグ用）
      return NextResponse.json(
        { ok: false, error: `Forbidden (admin only): ${email}` },
        { status: 403 }
      );
    }

    // ③ データ取得
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
    console.error("admin usage api error", e);
    return NextResponse.json(
      { ok: false, error: e?.message ?? String(e) },
      { status: 500 }
    );
  }
}
