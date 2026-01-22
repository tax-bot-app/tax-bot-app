// app/api/chat/route.ts
import { generateAnswer } from "../../lib2/ai/generateAnswer";
import type { PromptParts } from "../../lib2/ai/prompt";
import { judgeGuardrails } from "../../lib2/guardrails";
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

function safeStr(x: unknown): string {
  return typeof x === "string" ? x : "";
}

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
      return 0;
  }
}

type ConsumeTalkV2Result = {
  month_key: string;
  used_talks: number;
  limit_talks: number;
  allowed: boolean;
  already_counted: boolean;
};

type ChatRes =
  | {
      ok: true;
      plan: string;
      used_talks: number | null;
      limit_talks: number | null;
      conversation_id: string | null;
      message: string;
    }
  | {
      ok: false;
      error: string;
      used_talks?: number | null;
      limit_talks?: number | null;
    };

type Dialect = "kansai" | "standard";
type Stance = "zubatto" | "sanbo";

function buildStyleRules(dialect: Dialect, stance: Stance): string[] {
  const rules: string[] = [];

  // 口調
  if (dialect === "kansai") rules.push("口調は関西弁で。ただし失礼にならず、読みやすさ優先。");
  else rules.push("口調は標準語で。丁寧で簡潔に。");

  // モード
  if (stance === "zubatto") {
    rules.push("スタイルは結論ファーストでズバっと。余計な前置きは削る。");
  } else {
    rules.push("スタイルは参謀役。論点整理→選択肢→おすすめ→次のアクションの順で導く。");
  }

  return rules;
}

function summarizeSeed(text: string): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length <= 60 ? s : s.slice(0, 60) + "…";
}

async function ensureConversationId(params: {
  db: any;
  userId: string;
  conversationId: string | null;
  firstUserMessage: string;
}): Promise<string> {
  const { db, userId, conversationId, firstUserMessage } = params;

  // 既存が来てたら「自分のやつか」を確認
  if (conversationId && isUuid(conversationId)) {
    const { data } = await db
      .from("conversations")
      .select("id")
      .eq("id", conversationId)
      .eq("user_id", userId)
      .maybeSingle();

    if (data?.id) return data.id as string;
  }

  // なければ新規作成（summaryはまず“最初の一言短縮”でOK）
  const seed = summarizeSeed(firstUserMessage);
  const { data, error } = await db
    .from("conversations")
    .insert({
      user_id: userId,
      summary: seed,
      summary_updated_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error) throw error;
  if (!data?.id) throw new Error("failed to create conversation");

  return data.id as string;
}

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
    const conversationIdRaw = safeStr(body?.conversationId).trim();
    const dialect = (safeStr(body?.dialect) as Dialect) || "kansai";
    const stance = (safeStr(body?.stance) as Stance) || "zubatto";

    const conversationId = conversationIdRaw ? conversationIdRaw : null;

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

    // ① user取得
    const authClient = createClient(url, anon, { auth: { persistSession: false } });
    const { data: userRes, error: userErr } = await authClient.auth.getUser(token);
    if (userErr || !userRes?.user) {
      const res: ChatRes = { ok: false, error: "Invalid session" };
      return NextResponse.json(res, { status: 401 });
    }
    const user = userRes.user;

    // ② DBアクセス（RLS効かせる）
    const db = createClient(url, anon, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    // plan
    const { data: urow } = await db.from("users").select("plan").eq("id", user.id).maybeSingle();
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

    // 🛡 ガードレール（AI前）
    const gr = judgeGuardrails(message);
    if (gr.action === "block") {
      // Level1: AIにも渡さない / カウントもしない / DBにも残さない（危ない内容の保存を避ける）
      const res: ChatRes = {
        ok: true,
        plan,
        used_talks: null,
        limit_talks: null,
        conversation_id: null,
        message: gr.userMessage,
      };
      return NextResponse.json(res, { status: 200 });
    }

    // conversation id確定（なければ新規）
    const convId = await ensureConversationId({
      db,
      userId: user.id,
      conversationId,
      firstUserMessage: message,
    });

    // ③ AI回答（先に呼ぶ：失敗なら消費しない）
    let answer = "";
    try {
      const styleRules = buildStyleRules(dialect, stance);

      const promptParts: PromptParts = {
        // A: 今回は “直近” はまだ注入しない（DB保存だけ先にやる）
        context: [],
        injectedRules: styleRules,
        guardrails: gr.action === "inject" ? gr.guardrailLines : [],
      };

      const result = await generateAnswer({ message, promptParts });
      answer = result.answer;
    } catch (e: any) {
      const res: ChatRes = { ok: false, error: e?.message || "AI failed. Please retry." };
      return NextResponse.json(res, { status: 502 });
    }

    // ④ カウント（冪等）: 成功したら消費
    const { data, error } = await db.rpc("consume_talk_v2", {
      p_user_id: user.id,
      p_limit: limit,
      p_idempotency_key: idempotencyKey,
    });

    if (error) {
      const res: ChatRes = { ok: false, error: `consume_talk_v2 failed: ${error.message}` };
      return NextResponse.json(res, { status: 500 });
    }

    const usage = (Array.isArray(data) ? data[0] : data) as ConsumeTalkV2Result | null;
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

    // ⑤ DBに保存（課金OKになった後）
    try {
      await db.from("messages").insert([
        { conversation_id: convId, user_id: user.id, role: "user", content: message },
        { conversation_id: convId, user_id: user.id, role: "assistant", content: answer },
      ]);
      // summary が null のままの古い会話がある場合はここで補正してもOK（必要なら）
    } catch {
      // 保存失敗でも回答は返す（体験優先）
    }

    const res: ChatRes = {
      ok: true,
      plan,
      used_talks: usage.used_talks,
      limit_talks: usage.limit_talks,
      conversation_id: convId,
      message: answer,
    };
    return NextResponse.json(res, { status: 200 });
  } catch (e: any) {
    const res: ChatRes = { ok: false, error: e?.message ?? "Unknown error" };
    return NextResponse.json(res, { status: 500 });
  }
}
