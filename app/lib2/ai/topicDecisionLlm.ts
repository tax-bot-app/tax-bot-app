import OpenAI from "openai";
import { TOPIC_TAX_AUDIT } from "../topicDecision";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function safeJsonParse(s: string): any | null {
  const t = (s ?? "").trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    const i = t.indexOf("{");
    const j = t.lastIndexOf("}");
    if (i >= 0 && j > i) {
      try {
        return JSON.parse(t.slice(i, j + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function uniq(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs.map((v) => String(v ?? "").trim()).filter(Boolean)) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

export type LlmTopicIntent = "qa_first" | "need_lines" | "clarify" | "chitchat";

export type LlmTopicDecision = {
  axisTopic: string; // 税務調査 or ""
  subjectTopic: string;
  auditAxis: boolean;
  topicsNow: string[];
  intent: LlmTopicIntent;
  confidence: number; // 0-1
  reason: string;
};

export async function decideTopicByLLM(params: {
  message: string;
  prevUserMessage: string | null;
  prevAssistantMessage: string | null;
  recentUserMsgs: string[];
  availableTopics: string[];
}): Promise<
  | { ok: true; decision: LlmTopicDecision; rawText: string }
  | { ok: false; error: string; rawText: string }
> {
  const { message, prevUserMessage, prevAssistantMessage, recentUserMsgs, availableTopics } = params;

  const openai = new OpenAI({ apiKey: mustEnv("OPENAI_API_KEY") });
  const model = process.env.OPENAI_MODEL_TOPIC || process.env.OPENAI_MODEL || "gpt-5.2";

  const topics = uniq(availableTopics).slice(0, 220);

  const instructions = [
    "あなたは会話の『意図』と『主題』を決める分類器。",
    "必ず JSON のみを返す。コードブロック禁止。余計な文章禁止。",
    "",
    "subjectTopic は allowed_topics から完全一致で1つ選ぶ。",
    "axisTopic は税務調査軸を使う場合のみ '税務調査'、それ以外は空文字。",
    "",
    "intent の定義：",
    "- qa_first: まず概要整理（QA要約が適切）。攻め/守りはまだ出さない。",
    "- need_lines: ユーザーがギリ/上限/セーフアウト/攻め守り/金額レンジ等の『ライン』を求めている。",
    "- clarify: 直前回答の用語確認・意味質問など。",
    "- chitchat: 雑談・感想レベル。",
    "",
    "need_lines は厳しめ判定：",
    "- 『よろ』『お願い』『頼む』『続き』だけでは need_lines にしない。",
    "- 『上限/どこまで/ギリ/セーフ/アウト/グレー/いくら/レンジ/攻め守り/線引き』等がある時だけ。",
    "",
    "topicsNow は allowed_topics から最大3件（1番目は subjectTopic と同じ）。",
    "confidence は 0.0〜1.0。",
  ].join("\n");

  const input = [
    "allowed_topics:",
    topics.map((t) => `- ${t}`).join("\n"),
    "",
    "conversation:",
    `prev_user: ${(prevUserMessage ?? "").slice(0, 300)}`,
    `prev_assistant: ${(prevAssistantMessage ?? "").slice(0, 300)}`,
    `recent_user_msgs: ${JSON.stringify((recentUserMsgs ?? []).slice(0, 6).map((s) => String(s ?? "").slice(0, 200)))}`,
    `user_message: ${String(message ?? "").slice(0, 800)}`,
    "",
    "Return JSON with keys:",
    `{
  "subjectTopic": string,
  "axisTopic": string,
  "auditAxis": boolean,
  "topicsNow": string[],
  "intent": "qa_first"|"need_lines"|"clarify"|"chitchat",
  "confidence": number,
  "reason": string
}`,
  ].join("\n");

  let rawText = "";
  try {
    const res = await openai.responses.create({ model, instructions, input });
    rawText = (res.output_text ?? "").trim();

    const obj = safeJsonParse(rawText);
    if (!obj || typeof obj !== "object") return { ok: false, error: "llm_topic: invalid json", rawText };

    const subjectTopic = String(obj.subjectTopic ?? "").trim();
    const axisTopic = String(obj.axisTopic ?? "").trim();
    const auditAxis = Boolean(obj.auditAxis);
    const intent = String(obj.intent ?? "").trim() as LlmTopicIntent;
    const confidence = Number(obj.confidence ?? 0);
    const reason = String(obj.reason ?? "").trim();
    const topicsNow = Array.isArray(obj.topicsNow) ? obj.topicsNow.map((x: any) => String(x ?? "").trim()).filter(Boolean) : [];

    const allowSet = new Set(topics);
    if (!subjectTopic || !allowSet.has(subjectTopic)) {
      return { ok: false, error: "llm_topic: subjectTopic not in allowed_topics", rawText };
    }

    if (!(axisTopic === "" || axisTopic === TOPIC_TAX_AUDIT)) {
      return { ok: false, error: "llm_topic: axisTopic invalid", rawText };
    }

    const intentOk = intent === "qa_first" || intent === "need_lines" || intent === "clarify" || intent === "chitchat";
    if (!intentOk) return { ok: false, error: "llm_topic: intent invalid", rawText };

    const fixedTopicsNow = uniq([subjectTopic, ...topicsNow]).filter((t) => allowSet.has(t)).slice(0, 3);

    const decision: LlmTopicDecision = {
      subjectTopic,
      axisTopic: auditAxis ? TOPIC_TAX_AUDIT : "",
      auditAxis,
      topicsNow: fixedTopicsNow,
      intent,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
      reason,
    };

    return { ok: true, decision, rawText };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "llm_topic: failed", rawText };
  }
}
