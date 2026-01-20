// app/api/chat/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

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

function safeStr(x: unknown): string {
  return typeof x === "string" ? x : "";
}

// ざっくり UUID v4 っぽいかチェック（厳密じゃなくてOK）
function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s
  );
}

function limitFromPlan(plan: string): number {
  switch (plan) {
    case "enterprise":
      return 100;
    case "standard":
      return 30;
    case "lite":
      return 5;
    default:
      return 0; // free は 0（=許可しない）
  }
}

type ChatRes =
  | {
      ok: true;
      plan: string;
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

type ConsumeTalkV2Result = {
  month_key: string;
  used_talks: number;
  limit_talks: number;
  allowed: boolean;
  already_counted: boolean;
};

export async function POST(req: Request) {
  try {
    const token = bearer(req);
    if (!token) {
      const res: ChatRes = { ok: false, error: "Missing bearer token" };
      return NextResponse.json(res, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    const message = safeStr(body?.message).trim();
    const idempotencyKey = safeStr(body?.idempotencyKey).trim();

    if (!message) {
      const res: ChatRes = { ok: false, error: "message is required" };
      return NextResponse.json(res, { status: 400 });
    }
    if (!idempotencyKey) {
      const res: ChatRes = { ok: false, error: "idempotencyKey is required" };
      return NextResponse.json(res, { status: 400 });
    }
    if (!isUuid(idempotencyKey)) {
      const res: ChatRes = { ok: false, error: "idempotencyKey must be uuid" };
      return NextResponse.json(res, { status: 400 });
    }

    const url = mustEnv("NEXT_PUBLIC_SUPABASE_URL");
    const anon = mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

    // ① user取得（token指定で確実）
    const authClient = createClient(url, anon, {
      auth: { persistSession: false },
    });
    const { data: userRes, error: userErr } = await authClient.auth.getUser(
      token
    );
    if (userErr || !userRes?.user) {
      const res: ChatRes = { ok: false, error: "Invalid session" };
      return NextResponse.json(res, { status: 401 });
    }
    const user = userRes.user;

    // ② DBアクセスは Authorization header 付き（RLS効かせる）
    const db = createClient(url, anon, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    // plan 参照（無くてもfree扱い）
    const { data: urow } = await db
      .from("users")
      .select("plan")
      .eq("id", user.id)
      .maybeSingle();

    const plan = (urow?.plan as string) ?? "free";
    const limit = limitFromPlan(plan);

    if (limit <= 0) {
      const res: ChatRes = {
        ok: false,
        error: "Plan does not allow chat",
        used_talks: 0,
        limit_talks: 0,
      };
      return NextResponse.json(res, { status: 403 });
    }

    // =========================
    // ③ AI回答（先に呼ぶ：失敗なら消費しない）
    // =========================
    const openai = new OpenAI({ apiKey: mustEnv("OPENAI_API_KEY") });
    const model = process.env.OPENAI_MODEL || "gpt-5.2";

    const instructions = [
      "あなたは税務顧問bot『さじかげん』。",
      "日本の税務・会計の一般的な相談に、実務的にわかりやすく答える。",
      "断定できない点は確認事項を短く列挙し、仮説と分岐で提示する。",
      "危ない節税スキームや違法・脱法の依頼は断る。",
      "口調は丁寧だが回りくどくしない。",
    ].join("\n");

    let answer = "";
    try {
      const ai = await openai.responses.create({
        model,
        instructions,
        input: message,
      });

      answer = (ai.output_text && ai.output_text.trim()) || "";
    } catch (e: any) {
      // OpenAI例外 → 消費しない
      const res: ChatRes = { ok: false, error: "AI failed. Please retry." };
      return NextResponse.json(res, { status: 502 });
    }

    // 回答ゼロ（=エラー表示想定） → 消費しない
    if (!answer) {
      const res: ChatRes = { ok: false, error: "AI returned empty response. Please retry." };
      return NextResponse.json(res, { status: 502 });
    }

    // ※「（回答生成に失敗しました）」みたいな固定文を成功扱いにしない
    // ここでは「空じゃない＝成功」ルールにしてるので、固定文は返さない方針。
    // もし固定文にしたいなら “失敗扱いの文言” をここで弾く。

    // =========================
    // ④ カウント（冪等）: 成功したら消費
    // =========================
    const { data, error } = await db.rpc("consume_talk_v2", {
      p_user_id: user.id,
      p_limit: limit,
      p_idempotency_key: idempotencyKey,
    });

    if (error) {
      // AIは成功したがDB更新失敗 → ここでAI回答を返すと「無料回答」になるので返さない
      const res: ChatRes = { ok: false, error: `consume_talk_v2 failed: ${error.message}` };
      return NextResponse.json(res, { status: 500 });
    }

    const usage = (Array.isArray(data) ? data[0] : data) as
      | ConsumeTalkV2Result
      | null;

    if (!usage) {
      const res: ChatRes = { ok: false, error: "consume_talk_v2: empty result" };
      return NextResponse.json(res, { status: 500 });
    }

    if (!usage.allowed) {
      // 上限超過 → AI回答は返さない（無料で出さない）
      const res: ChatRes = {
        ok: false,
        error: "Monthly quota exceeded",
        used_talks: usage.used_talks,
        limit_talks: usage.limit_talks,
      };
      return NextResponse.json(res, { status: 429 });
    }

    // =========================
    // ✅ 成功
    // =========================
    const res: ChatRes = {
      ok: true,
      plan,
      used_talks: usage.used_talks,
      limit_talks: usage.limit_talks,
      message: answer,
    };
    return NextResponse.json(res, { status: 200 });
  } catch (e: any) {
    const res: ChatRes = { ok: false, error: e?.message ?? "Unknown error" };
    return NextResponse.json(res, { status: 500 });
  }
}
