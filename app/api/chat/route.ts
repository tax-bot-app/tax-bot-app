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

function normalizeDialect(x: string): Dialect {
  return x === "standard" ? "standard" : "kansai";
}
function normalizeStance(x: string): Stance {
  return x === "sanbo" ? "sanbo" : "zubatto";
}

/**
 * ✅ 出力ルール（さじかげんフォーマット）
 * - 見出し禁止
 * - 🥄ちょうど良いライン を基本
 * - 要求があった場合のみ 🍚🥄攻め / 🧂🥄守り を追加
 * - 最後に必ず決め台詞
 */
function buildOutputRules(): string[] {
  return [
    "Markdownの見出し（##、###など）は使わない。アイコンとテキストだけで構造化する。",

    "基本は以下の1ブロックのみで回答する：",
    "🥄 ちょうど良いライン（結論を簡潔に） → ✅要点（最大3つ） → ⚠️注意（必要なら最大2つ） → 🔎確認（原則1つ、最大1つ）",

    "ユーザーから『攻め』『守り』『他の見方』『リスク取りたい』『安全寄り』などの要求があった場合のみ、以下も追加する：",
    "🍚🥄 攻めライン（リスク許容・積極寄りの考え方）",
    "🧂🥄 守りライン（リスク最小化・保守寄りの考え方）",

    "複数ラインを出す場合の順番は必ず：🥄ちょうど良い → 🍚🥄攻め → 🧂🥄守り",

    "🔎確認質問は『結論が変わる可能性が高い』ものだけ1つに絞る。複数質問は禁止。",
    "その他の不明点は質問にせず『該当するなら〜』の注意に吸収する。",

    "回答の最後に、必ず次の決め台詞を入れる：",
    "「とはいえども、税務の世界は答えはひとつちゃうからな。攻め・守りラインの考え方も知りたかったら、遠慮なく言うてな！」",
  ];
}

/**
 * ✅ 口調・スタンス制御
 */
function buildStyleRules(dialect: Dialect, stance: Stance): string[] {
  const rules: string[] = [];

  if (dialect === "kansai") {
    rules.push("口調は自然な関西弁で話す。『です・ます調』の敬語は禁止。『やで・やな・やと思う・ちゃう』など口語を使う。");
    rules.push("乱暴・命令口調・上から目線にはならない。フラットで実務的な関西弁にする。");
  } else {
    rules.push("口調は標準語。丁寧で簡潔に。");
  }

  if (stance === "zubatto") {
    rules.push("スタイルは結論ファーストでズバっと。余計な前置きや一般論は削る。");
    rules.push("言いにくいことも、曖昧に逃げず率直に伝える（断定できない点は条件付きで表現）。");
  } else {
    rules.push("スタイルは参謀役。論点整理→選択肢→おすすめ→次アクションの順で導く。");
    rules.push("過度な断定は避け、実務上のリスクも併記する。");
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

  if (conversationId && isUuid(conversationId)) {
    const { data } = await db
      .from("conversations")
      .select("id")
      .eq("id", conversationId)
      .eq("user_id", userId)
      .maybeSingle();

    if (data?.id) return data.id as string;
  }

  const seed = summarizeSeed(firstUserMessage);

  const { data, error } = await db
    .from("conversations")
    .insert({
      user_id: userId,
      title: seed,
      summary: seed,
      summary_updated_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error) throw error;
  if (!data?.id) throw new Error("failed to create conversation");

  return data.id as string;
}

// --- コンテクスト生成 ---

function clampForContext(s: string, n: number) {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n) + "…";
}

type MsgMini = { role: "user" | "assistant"; content: string; created_at: string };

async function buildConversationContext(params: { db: any; convId: string }): Promise<string[]> {
  const { db, convId } = params;

  const lines: string[] = [];

  const { data: conv } = await db
    .from("conversations")
    .select("summary, created_at")
    .eq("id", convId)
    .maybeSingle();

  const summary = (conv?.summary ?? "").trim();
  if (summary) {
    lines.push(`【会話要約】${clampForContext(summary, 400)}`);
  }

  const N = Number(process.env.CHAT_CONTEXT_TURNS || "16");
  const { data: rows } = await db
    .from("messages")
    .select("role, content, created_at")
    .eq("conversation_id", convId)
    .order("created_at", { ascending: false })
    .limit(Math.max(0, Math.min(60, N)));

  const msgs = (rows ?? []) as MsgMini[];
  if (msgs.length > 0) {
    lines.push("【直近ログ】（古→新）");
    const asc = [...msgs].reverse();
    for (const m of asc) {
      const role = m.role === "user" ? "ユーザー" : "さじかげん";
      lines.push(`${role}: ${clampForContext(m.content, 600)}`);
    }
  }

  lines.push(
    "【ルール】会話要約・直近ログと矛盾しない範囲で回答する。確認は原則1つまで。"
  );

  return lines;
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

    const dialect = normalizeDialect(safeStr(body?.dialect).trim());
    const stance = normalizeStance(safeStr(body?.stance).trim());

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

    // user取得
    const authClient = createClient(url, anon, { auth: { persistSession: false } });
    const { data: userRes, error: userErr } = await authClient.auth.getUser(token);
    if (userErr || !userRes?.user) {
      const res: ChatRes = { ok: false, error: "Invalid session" };
      return NextResponse.json(res, { status: 401 });
    }
    const user = userRes.user;

    // DB
    const db = createClient(url, anon, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

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

    // ガードレール
    const gr = judgeGuardrails(message);
    if (gr.action === "block") {
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

    // conversation確定
    const convId = await ensureConversationId({
      db,
      userId: user.id,
      conversationId,
      firstUserMessage: message,
    });

    // AI
    let answer = "";
    try {
      const styleRules = buildStyleRules(dialect, stance);
      const outputRules = buildOutputRules();
      const contextLines = await buildConversationContext({ db, convId });

      const promptParts: PromptParts = {
        context: contextLines,
        injectedRules: [...outputRules, ...styleRules],
        guardrails: gr.action === "inject" ? gr.guardrailLines : [],
      };

      const result = await generateAnswer({ message, promptParts });
      answer = result.answer;
    } catch (e: any) {
      const res: ChatRes = { ok: false, error: e?.message || "AI failed. Please retry." };
      return NextResponse.json(res, { status: 502 });
    }

    // カウント
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

    // 保存
    try {
      await db.from("messages").insert([
        { conversation_id: convId, user_id: user.id, role: "user", content: message },
        { conversation_id: convId, user_id: user.id, role: "assistant", content: answer },
      ]);
    } catch {
      // ignore
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
