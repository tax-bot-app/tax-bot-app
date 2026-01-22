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
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
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
  | { ok: true; plan: string; used_talks: number | null; limit_talks: number | null; conversation_id: string | null; message: string }
  | { ok: false; error: string; used_talks?: number | null; limit_talks?: number | null };

type Dialect = "kansai" | "standard";
type Stance = "zubatto" | "sanbo";

function normalizeDialect(x: string): Dialect {
  return x === "standard" ? "standard" : "kansai";
}
function normalizeStance(x: string): Stance {
  return x === "sanbo" ? "sanbo" : "zubatto";
}

function buildOutputRules(): string[] {
  return [
    "Markdownの見出し（##、###など）は使わない。",
    "構成はこの順で固定：🧂ちょうど良いライン → ✅要点 → ⚠️注意（必要なら） → 🔎確認（原則1つ、最大1つ）。",
    "✅/⚠️/🔎 に『(最大◯つ)』などの注釈は書かない。",
    "🧂ちょうど良いラインの結論の1行は **太字** で書く（** **）。",
    "攻め/守りはユーザーが求めた時だけ出す。3パターンを出した時は決め台詞は書かない。",
    "通常（ちょうど良いだけ）の時は最後に決め台詞を1行：『とはいえども、税務の世界は答えはひとつちゃうからな。**攻め・守り**ラインの考え方も知りたかったら、遠慮なく言うてな！』",
  ];
}

function buildStyleRules(dialect: Dialect, stance: Stance): string[] {
  const rules: string[] = [];

  if (dialect === "kansai" && stance === "zubatto") {
    rules.push("口調は関西弁のズバっと。敬語禁止。");
    rules.push("禁止表現（絶対に使わない）：です、ます、でした、ません、ございます、ください、いただく、おります、〜ますか、〜でしょう、〜ですか。");
    rules.push("もし上の禁止表現が混ざったら、出力を最初から書き直して関西口語に直す。");
    rules.push("語尾例：や／で／やな／やろ／ちゃう／せやな／〜が無難／アウト寄り／OK寄り");
  } else if (dialect === "kansai") {
    rules.push("口調は関西弁。読みやすさ優先。");
  } else {
    rules.push("口調は標準語。丁寧で簡潔。");
  }

  if (stance === "zubatto") {
    rules.push("結論ファーストでズバっと。余計な前置きは削る。");
    rules.push("言いにくいこともハッキリ言う（断定できない所は断定しない）。");
  } else {
    rules.push("参謀役。論点整理→選択肢→おすすめ→次のアクションで導く。");
  }

  return rules;
}

function summarizeSeed(text: string): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length <= 60 ? s : s.slice(0, 60) + "…";
}

async function ensureConversationId(params: { db: any; userId: string; conversationId: string | null; firstUserMessage: string }): Promise<string> {
  const { db, userId, conversationId, firstUserMessage } = params;

  if (conversationId && isUuid(conversationId)) {
    const { data } = await db.from("conversations").select("id").eq("id", conversationId).eq("user_id", userId).maybeSingle();
    if (data?.id) return data.id as string;
  }

  const seed = summarizeSeed(firstUserMessage);
  const { data, error } = await db
    .from("conversations")
    .insert({ user_id: userId, title: seed, summary: seed, summary_updated_at: new Date().toISOString() })
    .select("id")
    .single();

  if (error) throw error;
  if (!data?.id) throw new Error("failed to create conversation");
  return data.id as string;
}

function clampForContext(s: string, n: number) {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n) + "…";
}
type MsgMini = { role: "user" | "assistant"; content: string; created_at: string };

async function buildConversationContext(params: { db: any; convId: string }): Promise<string[]> {
  const { db, convId } = params;
  const lines: string[] = [];

  const { data: conv } = await db.from("conversations").select("summary, summary_updated_at, created_at").eq("id", convId).maybeSingle();
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

  lines.push("【ルール】会話と矛盾しない。確認は原則1つ。");
  return lines;
}

export async function POST(req: Request) {
  try {
    const token = bearer(req);
    if (!token) return NextResponse.json({ ok: false, error: "Missing bearer token" } satisfies ChatRes, { status: 401 });

    const body = await req.json().catch(() => null);

    const message = safeStr(body?.message).trim();
    const idempotencyKey = safeStr(body?.idempotencyKey).trim();
    const conversationIdRaw = safeStr(body?.conversationId).trim();

    const dialect = normalizeDialect(safeStr(body?.dialect).trim());
    const stance = normalizeStance(safeStr(body?.stance).trim());

    const conversationId = conversationIdRaw ? conversationIdRaw : null;

    if (!message) return NextResponse.json({ ok: false, error: "message is required" } satisfies ChatRes, { status: 400 });
    if (!idempotencyKey) return NextResponse.json({ ok: false, error: "idempotencyKey is required" } satisfies ChatRes, { status: 400 });
    if (!isUuid(idempotencyKey)) return NextResponse.json({ ok: false, error: "idempotencyKey must be uuid" } satisfies ChatRes, { status: 400 });

    const url = mustEnv("NEXT_PUBLIC_SUPABASE_URL");
    const anon = mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

    const authClient = createClient(url, anon, { auth: { persistSession: false } });
    const { data: userRes, error: userErr } = await authClient.auth.getUser(token);
    if (userErr || !userRes?.user) return NextResponse.json({ ok: false, error: "Invalid session" } satisfies ChatRes, { status: 401 });
    const user = userRes.user;

    const db = createClient(url, anon, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { data: urow } = await db.from("users").select("plan").eq("id", user.id).maybeSingle();
    const plan = (urow?.plan as string) ?? "free";
    const limit = limitFromPlan(plan);

    if (limit <= 0) {
      return NextResponse.json(
        { ok: false, error: "Plan does not allow chat", used_talks: 0, limit_talks: 0 } satisfies ChatRes,
        { status: 403 }
      );
    }

    const gr = judgeGuardrails(message);
    if (gr.action === "block") {
      return NextResponse.json(
        { ok: true, plan, used_talks: null, limit_talks: null, conversation_id: null, message: gr.userMessage } satisfies ChatRes,
        { status: 200 }
      );
    }

    const convId = await ensureConversationId({ db, userId: user.id, conversationId, firstUserMessage: message });

    let answer = "";
    try {
      const outputRules = buildOutputRules();
      const styleRules = buildStyleRules(dialect, stance);
      const contextLines = await buildConversationContext({ db, convId });

      const promptParts: PromptParts = {
        context: contextLines,
        injectedRules: [...outputRules, ...styleRules],
        guardrails: gr.action === "inject" ? gr.guardrailLines : [],
      };

      const result = await generateAnswer({ message, promptParts });
      answer = result.answer;
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || "AI failed. Please retry." } satisfies ChatRes, { status: 502 });
    }

    const { data, error } = await db.rpc("consume_talk_v2", {
      p_user_id: user.id,
      p_limit: limit,
      p_idempotency_key: idempotencyKey,
    });

    if (error) return NextResponse.json({ ok: false, error: `consume_talk_v2 failed: ${error.message}` } satisfies ChatRes, { status: 500 });

    const usage = (Array.isArray(data) ? data[0] : data) as ConsumeTalkV2Result | null;
    if (!usage) return NextResponse.json({ ok: false, error: "consume_talk_v2: empty result" } satisfies ChatRes, { status: 500 });

    if (!usage.allowed) {
      return NextResponse.json(
        { ok: false, error: "Monthly quota exceeded", used_talks: usage.used_talks, limit_talks: usage.limit_talks } satisfies ChatRes,
        { status: 429 }
      );
    }

    try {
      await db.from("messages").insert([
        { conversation_id: convId, user_id: user.id, role: "user", content: message },
        { conversation_id: convId, user_id: user.id, role: "assistant", content: answer },
      ]);
    } catch {}

    return NextResponse.json(
      { ok: true, plan, used_talks: usage.used_talks, limit_talks: usage.limit_talks, conversation_id: convId, message: answer } satisfies ChatRes,
      { status: 200 }
    );
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "Unknown error" } satisfies ChatRes, { status: 500 });
  }
}
