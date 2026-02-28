// app/api/chat/status/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

type StatusRes =
  | { ok: true; plan: string; used_talks: number | null; limit_talks: number | null }
  | { ok: false; error: string };

export async function GET(req: Request) {
  try {
    const token = bearer(req);
    if (!token) {
      const res: StatusRes = { ok: true, plan: "free", used_talks: 0, limit_talks: 0 };
      return NextResponse.json(res);
    }

    const url = mustEnv("NEXT_PUBLIC_SUPABASE_URL");
    const anon = mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

    // ① user取得は token 指定で確実に
    const authClient = createClient(url, anon, { auth: { persistSession: false } });
    const { data: userRes, error: userErr } = await authClient.auth.getUser(token);

    if (userErr || !userRes?.user) {
      const res: StatusRes = { ok: true, plan: "free", used_talks: 0, limit_talks: 0 };
      return NextResponse.json(res);
    }

    const user = userRes.user;
    const month = new Date().toISOString().slice(0, 7);

    // ② DBアクセスは RLS効かせるため Authorization header 付きclient
    const db = createClient(url, anon, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    // users から plan / monthly_quota（=limitの基準）を取得
    const { data: urow, error: uerr } = await db
      .from("users")
      .select("plan, monthly_quota")
      .eq("id", user.id)
      .maybeSingle();

    if (uerr) {
      const res: StatusRes = { ok: false, error: uerr.message };
      return NextResponse.json(res, { status: 500 });
    }

    const plan = (urow?.plan as string) ?? "free";
    const baseLimit = Number(urow?.monthly_quota ?? 0);

     // ✅ 無制限（allowlist）なら usage 参照せずに返す
 const { data: isUnlimited, error: ulErr } = await db.rpc("is_unlimited_user", {
   p_user_id: user.id,
 });
 if (!ulErr && Boolean(isUnlimited)) {
   const res: StatusRes = { ok: true, plan, used_talks: 0, limit_talks: null };
   return NextResponse.json(res);
 }

    // usage（月次集計）
    const { data: usage, error: u2err } = await db
      .from("usage")
      .select("used_talks, limit_talks")
      .eq("user_id", user.id)
      .eq("month", month)
      .maybeSingle();

    if (u2err) {
      const res: StatusRes = { ok: false, error: u2err.message };
      return NextResponse.json(res, { status: 500 });
    }

    const used_talks = Number(usage?.used_talks ?? 0);
    const limit_talks = Number(usage?.limit_talks ?? baseLimit);

    const res: StatusRes = {
      ok: true,
      plan,
      used_talks,
      limit_talks,
    };
    return NextResponse.json(res);
  } catch (e: any) {
    const res: StatusRes = { ok: false, error: e?.message ?? "Unknown error" };
    return NextResponse.json(res, { status: 500 });
  }
}
