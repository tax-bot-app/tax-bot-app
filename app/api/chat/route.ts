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
      conversationId?: string;
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

type ContextMsg = { role: "user" | "assistant" | "system"; content: string };

async function ensureConversationId(params: {
  db: any;
  userId: string;
  conversationId: string | null;
}): Promise<string> {
  const { db, userId, conversationId } = params;

  if (conversationId) {
    const { data, error } = (await db
      .from("conversations")
      .select("id")
      .eq("id", conversationId)
      .eq("user_id", userId)
      .maybeSingle()) as any;

    if (error) throw error;
    if (!data) throw new Error("Conversation not found");
    return conversationId;
  }

  const { data, error } = (await db
    .from("conversations")
    .insert({ user_id: userId } as any)
    .select("id")
    .single()) as any;

  if (error) throw error;
  return data.id as string;
}

async function loadConversationContext(params: {
  db: any;
  userId: string;
  conversationId: string;
  historyLimit: number;
}): Promise<{
  summary: string | null;
  summaryUpdatedAt: string | null;
  context: ContextMsg[];
}> {
  const { db, userId, conversationId, historyLimit } = params;

  // conversation 本体（要約）
  const { data: conv, error: convErr } = (await db
    .from("conversations")
    .select("id, summary, summary_updated_at")
    .eq("id", conversationId)
    .eq("user_id", userId)
    .maybeSingle()) as any;

  if (convErr) throw convErr;

  const summary = (conv?.summary as string) ?? null;
  const summaryUpdatedAt = (conv?.summary_updated_at as string) ?? null;

  // 直近履歴
  const { data: rows, error: msgErr } = (await db
    .from("messages")
    .select("role, content, created_at")
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(historyLimit)) as any;

  if (msgErr) throw msgErr;

  const history = (Array.isArray(rows) ? rows : [])
    .slice()
    .reverse()
    .map((r: any) => ({
      role: r.role as "user" | "assistant" | "system",
      content: String(r.content ?? ""),
    }))
    .filter((m: ContextMsg) => m.content.trim().length > 0);

  const context: ContextMsg[] = [];

  if (summary && summary.trim()) {
    context.push({
      role: "system",
      content:
        "【これまでの会話要約】\n" +
        summary.trim() +
        "\n\n※この要約は参考情報。矛盾があれば直近の発言を優先すること。",
    });
  }

  // 既存の会話履歴（直近N件）
  context.push(...history);

  return { summary, summaryUpdatedAt, context };
}

function shouldUpdateSummary(params: {
  summaryUpdatedAt: string | null;
  nowIso: string;
  // 最低でもこれだけ会話が積まれてから更新する（頻繁更新を防ぐ）
  minMessagesToUpdate: number;
  // summary から何件増えたら更新するか（ざっくり）
  newlyAddedCount: number;
}): boolean {
  const { summaryUpdatedAt, nowIso, minMessagesToUpdate, newlyAddedCount } =
    params;

  if (newlyAddedCount < minMessagesToUpdate) return false;

  // summaryが無いなら作りに行く
  if (!summaryUpdatedAt) return true;

  // 直近すぎる更新は避ける（10分）
  const last = new Date(summaryUpdatedAt).getTime();
  const now = new Date(nowIso).getTime();
  if (!Number.isFinite(last) || !Number.isFinite(now)) return true;

  const diffMin = (now - last) / 1000 / 60;
  return diffMin >= 10;
}

async function updateConversationSummary(params: {
  db: any;
  userId: string;
  conversationId: string;
  existingSummary: string | null;
  maxMessagesForSummary: number;
}): Promise<void> {
  const { db, userId, conversationId, existingSummary, maxMessagesForSummary } =
    params;

  // 最新の会話をある程度拾って要約（AIコストはここだけ追加でかかる）
  const { data: rows, error } = (await db
    .from("messages")
    .select("role, content, created_at")
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(maxMessagesForSummary)) as any;

  if (error) throw error;

  const history = (Array.isArray(rows) ? rows : [])
    .slice()
    .reverse()
    .map((r: any) => `${r.role}: ${String(r.content ?? "")}`)
    .join("\n");

  const seed = (existingSummary ?? "").trim();

  const summarizerMsg =
    `あなたは「税務顧問bot さじかげん」の会話履歴を要約する係です。\n` +
    `次の方針で「更新後の要約」を1つだけ作ってください。\n\n` +
    `【要約ルール】\n` +
    `- 日本語\n` +
    `- 300〜600字くらい（長すぎない）\n` +
    `- 事実/前提/制約/未解決論点/次アクションを中心に\n` +
    `- 推測は入れない。曖昧なら「未確定」と明記。\n` +
    `- 箇条書きはOKだが、読みやすさ優先で。\n` +
    `- 最後に「次に聞くべき確認事項」を1〜3個だけ。\n\n` +
    `【既存の要約】\n${seed || "(なし)"}\n\n` +
    `【直近の会話ログ】\n${history}\n\n` +
    `---\n更新後の要約だけを出力して。`;

  const promptParts: PromptParts = {
    context: [],
    injectedRules: [],
    guardrails: [],
  };

  const result = await generateAnswer({
    message: summarizerMsg,
    promptParts,
  });

  const newSummary = (result.answer ?? "").trim();
  if (!newSummary) return;

  await db
    .from("conversations")
    .update({
      summary: newSummary,
      summary_updated_at: new Date().toISOString(),
    } as any)
    .eq("id", conversationId)
    .eq("user_id", userId);
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

    // B: 会話ID（任意）
    const conversationIdRaw = safeStr(body?.conversationId).trim();
    const conversationId =
      conversationIdRaw && isUuid(conversationIdRaw) ? conversationIdRaw : null;

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
    const { data: urow } = (await db
      .from("users")
      .select("plan")
      .eq("id", user.id)
      .maybeSingle()) as any;

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
    // 🛡 ガードレール判定（AI呼び出しより先）
    // =========================
    const gr = judgeGuardrails(message);

    if (gr.action === "block") {
      // Level1: AIにも渡さない / カウントもしない / 履歴にも残さない
      const res: ChatRes = {
        ok: true,
        plan,
        used_talks: null,
        limit_talks: null,
        message: gr.userMessage,
      };
      return NextResponse.json(res, { status: 200 });
    }

    // =========================
    // B: conversationId 確定
    // =========================
    let convId = "";
    try {
      convId = await ensureConversationId({
        db,
        userId: user.id,
        conversationId,
      });
    } catch (e: any) {
      const res: ChatRes = {
        ok: false,
        error: e?.message ?? "Conversation error",
      };
      return NextResponse.json(res, { status: 500 });
    }

    // =========================
    // B: 会話要約 + 直近履歴 読み込み
    // =========================
    let convSummary: string | null = null;
    let convSummaryUpdatedAt: string | null = null;
    let context: ContextMsg[] = [];

    try {
      const loaded = await loadConversationContext({
        db,
        userId: user.id,
        conversationId: convId,
        historyLimit: 12, // 直近N件（ここがAの「直近数件」）
      });
      convSummary = loaded.summary;
      convSummaryUpdatedAt = loaded.summaryUpdatedAt;
      context = loaded.context;
    } catch {
      // 履歴取得に失敗しても、回答自体は止めない
      context = [];
    }

    // =========================
    // ③ AI回答（先に呼ぶ：失敗なら消費しない）
    // =========================
    let answer = "";
    try {
      const promptParts: PromptParts = {
        // B: 会話履歴
        context: context as any,

        // C: ルール注入（次で強化）
        injectedRules: [],

        // A: ガードレール（今回）
        guardrails: gr.action === "inject" ? gr.guardrailLines : [],
      };

      const result = await generateAnswer({
        message,
        promptParts,
      });

      answer = result.answer;
    } catch (e: any) {
      const res: ChatRes = {
        ok: false,
        error: e?.message || "AI failed. Please retry.",
      };
      return NextResponse.json(res, { status: 502 });
    }

    // =========================
    // ④ カウント（冪等）: 成功したら消費
    // =========================
    const { data, error } = await db.rpc("consume_talk_v2", {
      p_user_id: user.id,
      p_limit: limit,
      p_idempotency_key: idempotencyKey,
    });

    if (error) {
      const res: ChatRes = {
        ok: false,
        error: `consume_talk_v2 failed: ${error.message}`,
      };
      return NextResponse.json(res, { status: 500 });
    }

    const usage = (Array.isArray(data) ? data[0] : data) as
      | ConsumeTalkV2Result
      | null;

    if (!usage) {
      const res: ChatRes = {
        ok: false,
        error: "consume_talk_v2: empty result",
      };
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

    // =========================
    // B: 履歴保存（consume成功後に確定）
    // =========================
    try {
      await db.from("messages").insert(
        {
          conversation_id: convId,
          user_id: user.id,
          role: "user",
          content: message,
        } as any
      );

      await db.from("messages").insert(
        {
          conversation_id: convId,
          user_id: user.id,
          role: "assistant",
          content: answer,
        } as any
      );
    } catch {
      // ここで落とさない
    }

    // =========================
    // A方針：保存は全部 / AIに渡すのは要約＋直近
    // → 要約は「たまに」更新する（頻繁更新はコスト増なので抑える）
    // =========================
    try {
      // summary後に何件積まれたか（ざっくり）
      const nowIso = new Date().toISOString();
      const since = convSummaryUpdatedAt;

      // 直近だけで判定する簡易版：summaryが無い or 10分以上更新なし → 更新候補
      // さらに「会話がある程度進んでから」だけ更新
      const { count } = (await db
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("conversation_id", convId)
        .eq("user_id", user.id)
        .gt("created_at", since ?? "1970-01-01T00:00:00.000Z")) as any;

      const newlyAddedCount = Number(count ?? 0);

      if (
        shouldUpdateSummary({
          summaryUpdatedAt: convSummaryUpdatedAt,
          nowIso,
          minMessagesToUpdate: 8,
          newlyAddedCount,
        })
      ) {
        await updateConversationSummary({
          db,
          userId: user.id,
          conversationId: convId,
          existingSummary: convSummary,
          maxMessagesForSummary: 20,
        });
      }
    } catch {
      // 要約更新は失敗しても無視（メイン導線を止めない）
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
      conversationId: convId,
    };
    return NextResponse.json(res, { status: 200 });
  } catch (e: any) {
    const res: ChatRes = { ok: false, error: e?.message ?? "Unknown error" };
    return NextResponse.json(res, { status: 500 });
  }
}
