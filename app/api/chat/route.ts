// app/api/chat/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getPlan, normalizePlanKey, type PlanKey } from "../../lib1/planMaster";

type ChatRes =
  | { ok: true; plan: PlanKey; used_talks: number; limit_talks: number; message: string }
  | { ok: false; error: string; used_talks?: number; limit_talks?: number };

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
      return NextResponse.json({ ok: false, error: "server env missing (supabase)" } satisfies ChatRes, { status: 500 });
    }

    const accessToken = bearerFromReq(req);
    if (!accessToken) {
      return NextResponse.json({ ok: false, error: "missing bearer token" } satisfies ChatRes, { status: 401 });
    }

    // 認証チェック（anonでOK）
    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey);
    const { data: userData, error: userErr } = await supabaseAuth.auth.getUser(accessToken);
    if (userErr || !userData?.user) {
      return NextResponse.json({ ok: false, error: "unauthorized" } satisfies ChatRes, { status: 401 });
    }
    const user = userData.user;

    // RLS通すためJWT付き client
    const supabaseDb = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    const json = (await req.json().catch(() => ({}))) as { message?: string; idempotencyKey?: string };
    const message = typeof json.message === "string" ? json.message.trim() : "";
    const idempotencyKey = typeof json.idempotencyKey === "string" ? json.idempotencyKey : "";

    if (!message) {
      return NextResponse.json({ ok: false, error: "message required" } satisfies ChatRes, { status: 400 });
    }
    if (!idempotencyKey || !isUuid(idempotencyKey)) {
      // 冪等性が命なので、ここは甘やかさない（事故防止）
      return NextResponse.json({ ok: false, error: "idempotencyKey (uuid) required" } satisfies ChatRes, { status: 400 });
    }

    // users から plan 取得
    const { data: urow, error: uerr } = await supabaseDb
      .from("users")
      .select("plan")
      .eq("id", user.id)
      .maybeSingle();

    if (uerr) {
      console.error("users select error:", uerr);
      return NextResponse.json({ ok: false, error: "db error (users)" } satisfies ChatRes, { status: 500 });
    }

    const plan: PlanKey = normalizePlanKey(urow?.plan ?? "free");
    const limit = getPlan(plan).monthlyQuota;

    if (!plan || plan === "free" || !limit || limit <= 0) {
      return NextResponse.json({ ok: false, error: "no active plan" } satisfies ChatRes, { status: 402 });
    }

    // 先に「枠確保」（冪等＋原子＋上限）
    const { data: consume, error: cerr } = await supabaseDb.rpc("consume_talk_v2", {
      p_user_id: user.id,
      p_limit: limit,
      p_idempotency_key: idempotencyKey,
    });

    if (cerr) {
      console.error("consume_talk_v2 error:", cerr);
      return NextResponse.json({ ok: false, error: "db error (consume_talk_v2)" } satisfies ChatRes, { status: 500 });
    }

    const row = Array.isArray(consume) ? consume[0] : consume;
    const used_talks = Number(row?.used_talks ?? 0);
    const limit_talks = Number(row?.limit_talks ?? limit);
    const exceeded = Boolean(row?.exceeded);

    if (exceeded) {
      return NextResponse.json(
        { ok: false, error: "quota exceeded", used_talks, limit_talks } satisfies ChatRes,
        { status: 402 }
      );
    }

    // ここでLLM呼び出し（今はダミー）
    const reply = `AI: 受け付けました（plan=${plan} / ${used_talks}/${limit_talks}）\n\nあなた: ${message}`;

    return NextResponse.json(
      { ok: true, plan, used_talks, limit_talks, message: reply } satisfies ChatRes,
      { status: 200 }
    );
  } catch (e: any) {
    console.error("chat route fatal:", e);
    return NextResponse.json({ ok: false, error: `server error: ${e?.message ?? "unknown"}` } satisfies ChatRes, { status: 500 });
  }
}
