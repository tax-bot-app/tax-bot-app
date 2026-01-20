// app/api/chat/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

import { getPlan, normalizePlanKey, type PlanKey } from "../../lib1/planMaster";

type ChatRes =
  | {
      ok: true;
      plan: PlanKey;
      used_talks: number | null;
      limit_talks: number | null;
      message: string;
    }
  | {
      ok: false;
      error: string;
      used_talks?: number | null;
      limit_talks?: number | null;
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
function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

export async function POST(req: Request) {
  try {
    const supabaseUrl = getSupabaseUrl();
    const supabaseAnonKey = getSupabaseAnonKey();

    if (!supabaseUrl || !supabaseAnonKey) {
      const body: ChatRes = { ok: false, error: "server env missing (supabase)" };
      return NextResponse.json(body, { status: 500 });
    }

    const accessToken = bearerFromReq(req);
    if (!accessToken) {
      const body: ChatRes = { ok: false, error: "missing bearer token" };
      return NextResponse.json(body, { status: 401 });
    }

    // ✅ 認証チェック（anonでOK）
    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey);
    const { data: userData, error: userErr } = await supabaseAuth.auth.getUser(accessToken);
    if (userErr || !userData?.user) {
      const body: ChatRes = { ok: false, error: "unauthorized" };
      return NextResponse.json(body, { status: 401 });
    }
    const user = userData.user;

    // ✅ DBアクセス（RLS通す）
    const supabaseDb = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    const { message, idempotencyKey } = (await req.json().catch(() => ({}))) as {
      message?: string;
      idempotencyKey?: string;
    };

    if (!message || typeof message !== "string" || !message.trim()) {
      const body: ChatRes = { ok: false, error: "message required" };
      return NextResponse.json(body, { status: 400 });
    }
    if (!idempotencyKey || typeof idempotencyKey !== "string" || !isUuid(idempotencyKey)) {
      const body: ChatRes = { ok: false, error: "idempotencyKey (uuid) required" };
      return NextResponse.json(body, { status: 400 });
    }

    // 1) users.plan → limit算出
    const { data: urow, error: uerr } = await supabaseDb
      .from("users")
      .select("plan")
      .eq("id", user.id)
      .maybeSingle();

    if (uerr) {
      console.error("users select error:", uerr);
      const body: ChatRes = { ok: false, error: "db error (users)" };
      return NextResponse.json(body, { status: 500 });
    }

    const plan: PlanKey = normalizePlanKey(urow?.plan ?? "free");
    const limit = getPlan(plan).monthlyQuota;

    if (!plan || plan === "free" || !limit || limit <= 0) {
      const body: ChatRes = { ok: false, error: "no active plan" };
      return NextResponse.json(body, { status: 402 });
    }

    // 2) ✅ consume_talk_v2（冪等 + JST月キー + ロック）
    const { data: consume, error: cerr } = await supabaseDb.rpc("consume_talk_v2", {
      p_user_id: user.id,
      p_limit: limit,
      p_idempotency_key: idempotencyKey,
    });

    if (cerr) {
      console.error("consume_talk_v2 error:", cerr);
      const body: ChatRes = { ok: false, error: "db error (consume_talk_v2)" };
      return NextResponse.json(body, { status: 500 });
    }

    // Supabase RPCは配列で返ることがあるので吸収
    const row = Array.isArray(consume) ? consume[0] : consume;

    const allowed = Boolean(row?.allowed);
    const used_talks: number | null = row?.used_talks ?? null;
    const limit_talks: number | null = row?.limit_talks ?? limit;

    if (!allowed) {
      const body: ChatRes = { ok: false, error: "quota exceeded", used_talks, limit_talks };
      return NextResponse.json(body, { status: 402 });
    }

    // 3) ここでAI応答（いまはダミー）
    const reply = `受け付けました（plan=${plan} / ${used_talks ?? "?"}/${limit_talks ?? "?"}）\n\nあなた: ${message.trim()}`;

    const body: ChatRes = {
      ok: true,
      plan,
      used_talks,
      limit_talks,
      message: reply,
    };
    return NextResponse.json(body, { status: 200 });
  } catch (e: any) {
    console.error("chat route fatal:", e);
    const body: ChatRes = { ok: false, error: `server error: ${e?.message ?? "unknown"}` };
    return NextResponse.json(body, { status: 500 });
  }
}
