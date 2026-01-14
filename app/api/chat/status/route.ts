// app/api/chat/status/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type StatusRes =
  | {
      ok: true;
      plan: string;
      used_talks: number | null;
      limit_talks: number | null;
    }
  | {
      ok: false;
      error: string;
    };

function env(name: string): string | undefined {
  return process.env[name];
}

function getSupabaseUrl(): string {
  return env("SUPABASE_URL") || env("NEXT_PUBLIC_SUPABASE_URL") || "";
}

function getSupabaseAnonKey(): string {
  return env("SUPABASE_ANON_KEY") || env("NEXT_PUBLIC_SUPABASE_ANON_KEY") || "";
}

function bearerFromReq(req: Request): string | null {
  const auth = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

export async function GET(req: Request) {
  try {
    const supabaseUrl = getSupabaseUrl();
    const supabaseAnonKey = getSupabaseAnonKey();

    if (!supabaseUrl || !supabaseAnonKey) {
      const body: StatusRes = { ok: false, error: "server env missing (supabase)" };
      return NextResponse.json(body, { status: 500 });
    }

    const accessToken = bearerFromReq(req);
    if (!accessToken) {
      const body: StatusRes = { ok: false, error: "missing bearer token" };
      return NextResponse.json(body, { status: 401 });
    }

    // 認証チェック（anonでOK）
    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey);
    const { data: userData, error: userErr } = await supabaseAuth.auth.getUser(accessToken);
    if (userErr || !userData?.user) {
      const body: StatusRes = { ok: false, error: "unauthorized" };
      return NextResponse.json(body, { status: 401 });
    }

    const user = userData.user;

    // RLS通すためJWT付き client
    const supabaseDb = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    // users から plan/quota
    const { data: urow, error: uerr } = await supabaseDb
      .from("users")
      .select("plan, monthly_quota")
      .eq("id", user.id)
      .maybeSingle();

    if (uerr) {
      console.error("users select error:", uerr);
      const body: StatusRes = { ok: false, error: "db error (users)" };
      return NextResponse.json(body, { status: 500 });
    }

    const plan = urow?.plan ?? "free";
    const limit_talks = urow?.monthly_quota ?? 0;

    // usage から used（無ければ0）
    const month = new Date().toISOString().slice(0, 7); // "YYYY-MM"
    const { data: usageRow, error: usErr } = await supabaseDb
      .from("usage")
      .select("used_talks")
      .eq("user_id", user.id)
      .eq("month", month)
      .maybeSingle();

    if (usErr) {
      // usage はまだ空運用でもOKにしたいので 500にせず 0 扱い
      console.warn("usage select warn:", usErr);
    }

    const used_talks = usageRow?.used_talks ?? 0;

    const body: StatusRes = { ok: true, plan, used_talks, limit_talks };
    return NextResponse.json(body, { status: 200 });
  } catch (e: any) {
    console.error("status route fatal:", e);
    const body: StatusRes = { ok: false, error: `server error: ${e?.message ?? "unknown"}` };
    return NextResponse.json(body, { status: 500 });
  }
}
