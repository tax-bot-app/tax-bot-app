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

function safeStr(x: unknown): string {
  return typeof x === "string" ? x : "";
}

export async function POST(req: Request) {
  try {
    // 0) Bearer token 必須
    const token = bearer(req);
    if (!token) {
      const res: ChatRes = { ok: false, error: "Missing bearer token" };
      return NextResponse.json(res, { status: 401 });
    }

    // 1) body
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

    // 2) Supabase env
    const url = mustEnv("NEXT_PUBLIC_SUPABASE_URL");
    const anon = mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

    // 3) user取得（token指定で確実）
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

    // 4) DBアクセスは Authorization header 付き（RLS効かせる）
    const db = createClient(url, anon, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    // 5) plan参照（無くてもfree扱い）
    const { data: urow } = await db
      .from("users")
      .select("plan")
      .eq("id", user.id)
      .maybeSingle();

    const plan = (urow?.plan as string) ?? "free";

    // 6) カウント（冪等）
    const { data, error } = await db.rpc("consume_talk_v2", {
      p_idempotency_key: idempotencyKey,
    });

    if (error) {
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
      const res: ChatRes = {
        ok: false,
        error: "Monthly quota exceeded",
        used_talks: usage.used_talks,
        limit_talks: usage.limit_talks,
      };
      return NextResponse.json(res, { status: 429 });
    }

    // 7) AI回答（OpenAI Responses API）
    const openai = new OpenAI({ apiKey: mustEnv("OPENAI_API_KEY") });
    const model = process.env.OPENAI_MODEL || "gpt-5.2";

    const instructions = [
      "あなたは税務顧問bot『さじかげん』。",
      "日本の税務・会計の一般的な相談に、実務的にわかりやすく答える。",
      "断定できない点は確認事項を短く列挙し、仮説と分岐で提示する。",
      "危ない節税スキームや違法・脱法の依頼は断る。",
      "口調は丁寧だが回りくどくしない。",
    ].join("\n");

    const ai = await openai.responses.create({
      model,
      instructions,
      input: message,
      // 任意（暴走・コスト対策。好みでON）
      // max_output_tokens: 700,
    });

    const answer =
      (ai.output_text && ai.output_text.trim()) ||
      "（回答生成に失敗しました）";

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
