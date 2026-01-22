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
  | {
      ok: true;
      plan: string;
      used_talks: number | null;
      limit_talks: number | null;
      conversation_id: string | null;
      message: string;
    }
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
    "攻め/守りはユーザーが求めた時だけ出す。",
    "🍚攻め と 🧂守り（3パターン）を出した時は決め台詞は禁止。",
    "決め台詞はサーバ側で付与するので、本文では決め台詞を書かない（重複防止）。",
  ];
}

// 禁止語（“混在”を止めるための実務用）
// ・ズバっとは標準語でもタメ口（敬語禁止）
// ・関西弁は参謀でも敬語に逃げない（混在が一番ダサい）
const FORBIDDEN_POLITE = [
  "です",
  "ます",
  "でした",
  "ません",
  "ございます",
  "ください",
  "いただ",
  "おります",
  "でしょう",
  "ますか",
  "ですか",
];

function forbiddenFor(dialect: Dialect, stance: Stance): string[] | null {
  if (stance === "zubatto") return FORBIDDEN_POLITE; // ズバっとは常にタメ口
  if (dialect === "kansai") return FORBIDDEN_POLITE; // 関西弁も“です/ます混在”禁止
  return null; // 標準語×参謀だけは敬語OK
}

function findForbiddenHits(text: string, forbidden: string[]): string[] {
  const hits: string[] = [];
  for (const w of forbidden) {
    if (text.includes(w)) hits.push(w);
  }
  // 重複排除
  return Array.from(new Set(hits));
}

function buildStyleRules(dialect: Dialect, stance: Stance): string[] {
  const rules: string[] = [];

  // スタンス（距離感＋戦術）
  if (stance === "zubatto") {
    rules.push("人格はパーソナルジムの人気トレーナー。あめと鞭を使い分ける。");
    rules.push("結論ファーストで短くズバっと。余計な前置きは削る。");
    rules.push("口調はタメ口。丁寧語（です/ます）は禁止。");
    rules.push("言いにくいこともハッキリ言う（断定できない所は断定しない）。");
  } else {
    rules.push("人格は参謀。論点整理→選択肢→おすすめ→次のアクションで導く。");
    rules.push("情報が足りない所は、結論を急がず条件分岐で整理する。");
  }

  // 方言（語彙・語尾）
  if (dialect === "kansai") {
    rules.push("語彙・語尾は関西弁の口語。『です/ます』に逃げない（混在禁止）。");
    rules.push("語尾例：や／で／やな／やろ／ちゃう／せやな／〜が無難／アウト寄り／OK寄り");
  } else {
    rules.push("言葉は標準語。");
    if (stance === "zubatto") {
      rules.push("標準語でもタメ口：だ／だよ／だな／〜だろ／〜じゃない／まず〜して。");
      rules.push("丁寧語は禁止（です/ます/ください/でしょう等）。");
    } else {
      rules.push("標準語の参謀。丁寧で簡潔（です/ますOK）。");
    }
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

  lines.push("【ルール】会話と矛盾しない。確認は原則1つ。");
  return lines;
}

function hasThreePatterns(answer: string): boolean {
  const hasAttack = answer.includes("🍚");
  const hasDefense = answer.includes("🧂守り") || answer.includes("🧂🥄") || answer.includes("🧂 守り");
  return hasAttack && hasDefense;
}

function isCatchphraseLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (t.includes("とはいえ")) return true;
  if (t.includes("税務の世界") && t.includes("答え")) return true;
  return false;
}

function catchphraseFor(dialect: Dialect, stance: Stance): string {
  // ズバっとは常にタメ口（標準語でも）
  if (dialect === "kansai") {
    return "とはいえども、税務の世界は答えはひとつちゃうからな。**攻め・守り**ラインも知りたかったら、遠慮なく言うてな！";
  }

  // 標準語
  if (stance === "sanbo") {
    // 参謀だけは丁寧語OK
    return "とはいえ、税務の世界は答えが一つとは限りません。**攻め・守り**ラインも必要なら教えてください。";
  }
  // 標準語ズバっと（タメ口）
  return "とはいえ、税務の世界は答えが一つじゃない。**攻め・守り**ラインも知りたければ、遠慮なく言って。";
}

function postProcessAnswer(raw: string, dialect: Dialect, stance: Stance): string {
  let a = String(raw ?? "").replace(/\r\n/g, "\n").trim();

  // 「(最大◯つ)」系を機械的に落とす（意図せず混ざるのを防ぐ）
  a = a.replace(/[\(（]最大[^)）]*[\)）]/g, "");

  // 🔎が複数出たら2つ目以降の「🔎始まり行」だけ落とす（保険）
  {
    const lines = a.split("\n");
    let seen = false;
    const out: string[] = [];
    for (const line of lines) {
      const t = line.trimStart();
      if (t.startsWith("🔎")) {
        if (seen) continue;
        seen = true;
      }
      out.push(line);
    }
    a = out.join("\n").trim();
  }

  // 3パターン時は決め台詞を削除（サーバ側でも確定させる）
  if (hasThreePatterns(a)) {
    const lines = a.split("\n");
    const out = lines.filter((line) => !isCatchphraseLine(line));
    a = out.join("\n").trim();
    return a;
  }

  // 通常時は決め台詞を必ず1行だけ付与（AIの揺れを殺す）
  const lines = a.split("\n");
  const already = lines.some((line) => isCatchphraseLine(line));
  if (!already) {
    a = `${a}\n\n${catchphraseFor(dialect, stance)}`.trim();
  }

  return a;
}

async function generateAnswerStrict(params: {
  message: string;
  promptPartsBase: PromptParts;
  dialect: Dialect;
  stance: Stance;
}): Promise<string> {
  const { message, promptPartsBase, dialect, stance } = params;

  const forbidden = forbiddenFor(dialect, stance);
  let last = "";
  let lastHits: string[] = [];

  const MAX = 3; // 実運用向け：無限ループしない範囲で現実的に抑える
  for (let attempt = 0; attempt < MAX; attempt++) {
    const extra =
      attempt === 0 || !forbidden || lastHits.length === 0
        ? []
        : [
            `前の出力に禁止表現が混ざってた：${lastHits.join("、")}。禁止表現をゼロにして、全文を書き直す。`,
            "書き直し後も禁止表現が1つでも含まれてたら不合格。",
          ];

    const promptParts: PromptParts = {
      ...promptPartsBase,
      injectedRules: [...(promptPartsBase.injectedRules ?? []), ...extra],

    };

    const result = await generateAnswer({ message, promptParts });
    last = postProcessAnswer(result.answer, dialect, stance);

    if (!forbidden) return last;

    lastHits = findForbiddenHits(last, forbidden);
    if (lastHits.length === 0) return last;
  }

  // ここに落ちたら「できるだけマシな最終」を返す（現場止めない）
  return last;
}

export async function POST(req: Request) {
  try {
    const token = bearer(req);
    if (!token)
      return NextResponse.json({ ok: false, error: "Missing bearer token" } satisfies ChatRes, {
        status: 401,
      });

    const body = await req.json().catch(() => null);

    const message = safeStr(body?.message).trim();
    const idempotencyKey = safeStr(body?.idempotencyKey).trim();
    const conversationIdRaw = safeStr(body?.conversationId).trim();

    const dialect = normalizeDialect(safeStr(body?.dialect).trim());
    const stance = normalizeStance(safeStr(body?.stance).trim());

    const conversationId = conversationIdRaw ? conversationIdRaw : null;

    if (!message)
      return NextResponse.json({ ok: false, error: "message is required" } satisfies ChatRes, {
        status: 400,
      });
    if (!idempotencyKey)
      return NextResponse.json({ ok: false, error: "idempotencyKey is required" } satisfies ChatRes, {
        status: 400,
      });
    if (!isUuid(idempotencyKey))
      return NextResponse.json({ ok: false, error: "idempotencyKey must be uuid" } satisfies ChatRes, {
        status: 400,
      });

    const url = mustEnv("NEXT_PUBLIC_SUPABASE_URL");
    const anon = mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

    const authClient = createClient(url, anon, { auth: { persistSession: false } });
    const { data: userRes, error: userErr } = await authClient.auth.getUser(token);
    if (userErr || !userRes?.user)
      return NextResponse.json({ ok: false, error: "Invalid session" } satisfies ChatRes, {
        status: 401,
      });
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
        {
          ok: true,
          plan,
          used_talks: null,
          limit_talks: null,
          conversation_id: null,
          message: gr.userMessage,
        } satisfies ChatRes,
        { status: 200 }
      );
    }

    const convId = await ensureConversationId({
      db,
      userId: user.id,
      conversationId,
      firstUserMessage: message,
    });

    let answer = "";
    try {
      const outputRules = buildOutputRules();
      const styleRules = buildStyleRules(dialect, stance);
      const contextLines = await buildConversationContext({ db, convId });

      const promptPartsBase: PromptParts = {
        context: contextLines,
        injectedRules: [...outputRules, ...styleRules],
        guardrails: gr.action === "inject" ? gr.guardrailLines : [],
      };

      answer = await generateAnswerStrict({ message, promptPartsBase, dialect, stance });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || "AI failed. Please retry." } satisfies ChatRes, {
        status: 502,
      });
    }

    const { data, error } = await db.rpc("consume_talk_v2", {
      p_user_id: user.id,
      p_limit: limit,
      p_idempotency_key: idempotencyKey,
    });

    if (error)
      return NextResponse.json({ ok: false, error: `consume_talk_v2 failed: ${error.message}` } satisfies ChatRes, {
        status: 500,
      });

    const usage = (Array.isArray(data) ? data[0] : data) as ConsumeTalkV2Result | null;
    if (!usage)
      return NextResponse.json({ ok: false, error: "consume_talk_v2: empty result" } satisfies ChatRes, {
        status: 500,
      });

    if (!usage.allowed) {
      return NextResponse.json(
        { ok: false, error: "Monthly quota exceeded", used_talks: usage.used_talks, limit_talks: usage.limit_talks } satisfies ChatRes,
        { status: 429 }
      );
    }

    // DB保存（失敗しても回答自体は返す：UI側で“欠けたら補完”する実装にしてある）
    try {
      await db.from("messages").insert([
        { conversation_id: convId, user_id: user.id, role: "user", content: message },
        { conversation_id: convId, user_id: user.id, role: "assistant", content: answer },
      ]);
    } catch {}

    return NextResponse.json(
      {
        ok: true,
        plan,
        used_talks: usage.used_talks,
        limit_talks: usage.limit_talks,
        conversation_id: convId,
        message: answer,
      } satisfies ChatRes,
      { status: 200 }
    );
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "Unknown error" } satisfies ChatRes, { status: 500 });
  }
}
