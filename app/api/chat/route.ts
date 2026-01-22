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
 * ✅ ちょうど良いライン運用ルール
 * - 見出し（##/###）禁止
 * - アイコンで構造化
 * - 「確認」は原則1つ（最大1つ）
 * - ちょうど良いラインだけの時だけ決め台詞（攻め・守りを太字で誘導）
 * - 攻め/守りを出した時は決め台詞は出さない（くどいから）
 */
function buildOutputRules(): string[] {
  return [
    "Markdownの見出し（##、###など）は使わない。代わりにアイコンで構造化する。",
    "最初に必ず「🧂 ちょうど良いライン」を出す。『結論の1行』は必ず太字（** **）にする。",
    "構成は必ずこの順：🧂ちょうど良いライン → ✅要点 → ⚠️注意（必要なら） → 🔎確認（原則1つ、最大1つ）。",
    "✅/⚠️/🔎 の見出しに (最大〇つ) の文言は付けない（不要）。",
    "🔎確認質問は『結論が変わる可能性が高い』ものだけに絞る。その他の不明点は『該当するなら〜』の注意に吸収する。",
    "文章は短め。箇条書き優先。冗長な前置きは禁止。",
    "ユーザーが『攻め』『守り』『攻めライン』『守りライン』などを求めた場合のみ、追加で 🍚攻めライン と 🧂守りライン を出す。",
    "🍚攻めライン/🧂守りライン を出した場合、最後の決め台詞は書かない（くどいから）。",
    "ちょうど良いラインだけで終える場合、最後に決め台詞を1行だけ付ける：『とはいえども、税務の世界は答えはひとつちゃうからな。**攻め・守り**ラインの考え方も知りたかったら、遠慮なく言うてな！』",
  ];
}

function buildStyleRules(dialect: Dialect, stance: Stance): string[] {
  const rules: string[] = [];

  if (dialect === "kansai") {
    rules.push("口調は関西弁。読みやすさ優先。");
  } else {
    rules.push("口調は標準語。簡潔で丁寧。");
  }

  if (dialect === "kansai" && stance === "zubatto") {
    rules.push("関西弁×ズバっとは敬語禁止。『です/ます/でした/ますね/ございます』などは使わない。");
    rules.push("語尾は『や/で/やねん/やろ/ちゃう/せやな』などの自然な関西口語に寄せる。");
    rules.push("結論ファーストでズバっと。余計な前置きは削る。");
    rules.push("言いにくいこともハッキリ言う（断定できない所は断定しない）。");
  } else if (stance === "zubatto") {
    rules.push("結論ファーストでズバっと。余計な前置きは削る。");
    rules.push("言いにくいことも、配慮しつつハッキリ言う（断定できない所は断定しない）。");
    rules.push("標準語の時は丁寧語でもOK。");
  } else {
    rules.push("スタイルは参謀役。論点整理→選択肢→おすすめ→次のアクションの順で導く。");
    rules.push("敬語で、出過ぎた断定は避け、前提条件を明確化する。");
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
    .select("summary, summary_updated_at, created_at")
    .eq("id", convId)
    .maybeSingle();

  const summary = (conv?.summary ?? "").trim();
  if (summary) lines.push(`【会話要約】${clampForContext(summary, 400)}`);

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
    for (const m of [...msgs].reverse()) {
      const role = m.role === "user" ? "ユーザー" : "さじかげん";
      lines.push(`${role}: ${clampForContext(m.content, 600)}`);
    }
  }

  lines.push(
    "【ルール】上の会話要約・直近ログと矛盾しない範囲で回答する。矛盾があるなら確認質問を先に出す（ただし確認は原則1つ）。"
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

    // ④ カウント（冪等）
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

    // ⑤ DBに保存
    try {
      await db.from("messages").insert([
        { conversation_id: convId, user_id: user.id, role: "user", content: message },
        { conversation_id: convId, user_id: user.id, role: "assistant", content: answer },
      ]);
    } catch {
      // 保存失敗でも回答は返す
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
