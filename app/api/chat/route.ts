// app/api/chat/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

import { getPlan, normalizePlanKey, type PlanKey } from "../../lib1/planMaster";

// もし Edge で動かしたいなら下記を有効化（NodeでもOKなら不要）
// export const runtime = "edge";

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

    // ✅ 認証チェック用（anonでOK）
    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey);
    const { data: userData, error: userErr } = await supabaseAuth.auth.getUser(accessToken);
    if (userErr || !userData?.user) {
      const body: ChatRes = { ok: false, error: "unauthorized" };
      return NextResponse.json(body, { status: 401 });
    }

    const user = userData.user;

    // ✅ DBアクセス用 client は JWT付き（RLS通す）
    const supabaseDb = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    const { message } = (await req.json().catch(() => ({}))) as { message?: string };

    if (!message || typeof message !== "string" || !message.trim()) {
      const body: ChatRes = { ok: false, error: "message required" };
      return NextResponse.json(body, { status: 400 });
    }

    // 1) users から plan だけ取得（monthly_quotaは使わない）
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

    // free / quota 0 は no active plan
    if (!plan || plan === "free" || !limit || limit <= 0) {
      const body: ChatRes = { ok: false, error: "no active plan" };
      return NextResponse.json(body, { status: 402 });
    }

    // 2) 回数消費（RPC consume_talk）
    const { data: consume, error: cerr } = await supabaseDb.rpc("consume_talk", {
      p_user_id: user.id,
      p_limit: limit,
    });

    if (cerr) {
      console.error("consume_talk error:", cerr);
      const body: ChatRes = { ok: false, error: "db error (consume_talk)" };
      return NextResponse.json(body, { status: 500 });
    }

    // consume の形に強く依存しないようにゆるく拾う
    const used_talks: number | null =
      (consume &&
        (consume.used_talks ??
          consume.used ??
          consume[0]?.used_talks ??
          consume[0]?.used)) ??
      null;

    const limit_talks: number | null =
      (consume &&
        (consume.limit_talks ??
          consume.limit ??
          consume[0]?.limit_talks ??
          consume[0]?.limit)) ??
      limit;

    // quota超過の判定（RPC側で弾いてるなら、ここは保険）
    if (typeof used_talks === "number" && typeof limit_talks === "number" && used_talks > limit_talks) {
      const body: ChatRes = { ok: false, error: "quota exceeded", used_talks, limit_talks };
      return NextResponse.json(body, { status: 402 });
    }

    // 3) ここでAI応答（いまはダミー。既存のLLM呼び出しに置換してOK）
    const reply = `AI: 受け付けました（plan=${plan} / ${used_talks ?? "?"}/${limit_talks ?? "?"}）\n\nあなた: ${message.trim()}`;

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
