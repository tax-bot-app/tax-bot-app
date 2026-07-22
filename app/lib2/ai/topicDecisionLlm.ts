import { withOpenAIModelFallback } from "@/app/lib/openaiResponse";
import { TOPIC_TAX_AUDIT } from "../topicDecision";

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

export type LlmTopicIntent = "qa_first" | "qa_more" | "need_lines" | "clarify" | "chitchat";

export type LlmTopicDecision = {
  axisTopic: string; // 税務調査 or ""
  subjectTopic: string;
  auditAxis: boolean;
  topicsNow: string[];
  intent: LlmTopicIntent;
  confidence: number; // 0-1
  reason: string;

  // 誘導（攻め守り/さじかげん）を出す提案
  nudgeLines: boolean;
  nudgeReason: string;

  // ★NEW: 話題転換の「空気」判定（キーワード依存を避ける）
  shiftCue: boolean;
  shiftCueReason: string;
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

  const topics = uniq(availableTopics).slice(0, 220);

  const instructions = [
    "あなたは会話の『意図(intent)』と『主題(subjectTopic)』を決める分類器。",
    "必ず JSON のみを返す。コードブロック禁止。余計な文章禁止。",
    "",
    "【最重要：主題の扱い】",
    "- 主題(subjectTopic)が特定できない場合は、推測で補完しない。必ず空文字 \"\" を返す。",
    "- 主語が不明な線引き質問（例：「どこまで？」「いくらまで？」）は、主題不明として扱い subjectTopic は空にする。",
    "- 「制度基準」「一般論」など包括的トピックを、主語不明の穴埋めに使ってはならない。",
    "",
    "subjectTopic のルール：",
    "- 特定できる場合のみ allowed_topics から完全一致で1つ選ぶ。",
    "- 特定できない場合は空文字 \"\"。",
    "",
    "axisTopic のルール：",
    "- 税務調査軸を使う場合のみ '税務調査'、それ以外は空文字。",
    "",
    "intent の定義：",
    "- qa_first: まず概要整理（QA要約が適切）。攻め/守りはまだ出さない。",
    "- qa_more: 直前の概要整理（qa_first）の『続き』。短い承諾/促し（例：お願い/よろ/続き/それで）に対して、要点を1段だけ追加する。",
    "- need_lines: ユーザーがギリ/上限/セーフアウト/攻め守り/金額レンジ等の『線引き』を求めている。",
    "- clarify: 直前回答の用語確認・意味質問、または主語不明で確認が必要なケース。",
    "- chitchat: 雑談・感想レベル。",
    "",
    "nudgeLines の定義：",
    "- nudgeLines: 回答の末尾に『攻め守りで / さじかげんよろ』の誘導（決めゼリフ）を出した方が良いか。",
    "- true にするのは、ユーザーが「もっと踏み込みたい」気配がある時だけ（例：線引き・比較・不安・地雷回避・実務の次の一手が欲しい）。",
    "- false にするのは、定義質問（例：不課税とは？）、雑談、短文承諾（よろ/お願い/続き）、clarify（主語確認）など。",
    "- nudgeLines は『Lines（🍚🧂）を出すか』ではない。誘導文を出すかどうかだけ。",
    "- nudgeReason は短く。",
    "",
    "shiftCue の定義：",
    "- shiftCue: ユーザーが「前の話の続き」ではなく「別の話題に移りたい空気」を出しているか。",
    "- true にする例：話題を切り替えたい意図が文脈から読み取れる（明示・暗示どちらでも）/ 直前テーマと別テーマに触れ始めている。",
    "- false にする例：短文追撃（それってさ…/で？/どうなん？）/ 直前回答への確認・補足 / 合言葉（攻め守りで/さじかげん）。",
    "- shiftCue は『強制転換』ではない。system が借り・shift を決めるための参考信号。",
    "- shiftCueReason は短く。",
    "",
    "判定ガイド：",
    "- ユーザー発話が短い承諾/促しだけの場合、まず qa_more を優先する。",
    "- 『よろ』『お願い』『頼む』『続き』だけでは need_lines にしない。",
    "- need_lines は『上限/どこまで/ギリ/セーフ/アウト/グレー/いくら/レンジ/攻め守り/線引き』等がある時だけ。",
    "- ただし need_lines でも主題が特定できない場合は intent を clarify にする（= 主語確認）。",
    "",
    "topicsNow のルール：",
    "- subjectTopic がある場合：allowed_topics から最大3件（1番目は subjectTopic と同じ）。",
    "- subjectTopic が空の場合：topicsNow は空配列 [] にする。",
    "",
    "confidence は 0.0〜1.0。",
  ].join("\n\n");

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
  "subjectTopic": string,  // allowed_topics から選ぶか、特定不能なら ""
  "axisTopic": string,     // "" or "税務調査"
  "auditAxis": boolean,
  "topicsNow": string[],   // subjectTopic=="" のときは []
  "intent": "qa_first"|"qa_more"|"need_lines"|"clarify"|"chitchat",
  "confidence": number,
  "reason": string,

  "nudgeLines": boolean,   // 誘導（決めゼリフ）を出す提案
  "nudgeReason": string,   // その理由（短く）

  "shiftCue": boolean,     // ★NEW: 話題転換の空気
  "shiftCueReason": string // ★NEW: その理由（短く）
}`,
  ].join("\n");

  let rawText = "";
  try {
    const res = await withOpenAIModelFallback({
      purpose: "topic",
      run: (openai, model) => openai.responses.create({ model, instructions, input }),
    });
    rawText = (res.output_text ?? "").trim();

    const obj = safeJsonParse(rawText);
    if (!obj || typeof obj !== "object") return { ok: false, error: "llm_topic: invalid json", rawText };

        const TOPIC_DENYLIST = new Set(["制度基準", "一般論"]);

    const subjectTopic0 = String(obj.subjectTopic ?? "").trim();
    const subjectTopic = TOPIC_DENYLIST.has(subjectTopic0) ? "" : subjectTopic0;

    const axisTopic = String(obj.axisTopic ?? "").trim();
    const auditAxis = Boolean(obj.auditAxis);
    const intent = String(obj.intent ?? "").trim() as LlmTopicIntent;
    const confidence = Number(obj.confidence ?? 0);
    const reason = String(obj.reason ?? "").trim();

    const nudgeLines = Boolean(obj.nudgeLines);
    const nudgeReason = String(obj.nudgeReason ?? "").trim();

    const shiftCue = Boolean(obj.shiftCue);
    const shiftCueReason = String(obj.shiftCueReason ?? "").trim();

    const topicsNowRaw: string[] = (() => {
  if (!Array.isArray(obj.topicsNow)) return [];
  const arr = obj.topicsNow as any[];
  const out: string[] = [];
  for (const x of arr) {
    const s = String(x ?? "").trim();
    if (s) out.push(s);
  }
  return out;
})();

const topicsNow: string[] = topicsNowRaw.filter((t: string) => !TOPIC_DENYLIST.has(t));



    const allowSet = new Set(topics);


    // subjectTopic は「特定できる時だけ」allowed_topics から選ぶ。特定不能なら空文字を許可。
    if (subjectTopic !== "" && !allowSet.has(subjectTopic)) {
      return { ok: false, error: "llm_topic: subjectTopic not in allowed_topics", rawText };
    }

    if (!(axisTopic === "" || axisTopic === TOPIC_TAX_AUDIT)) {
      return { ok: false, error: "llm_topic: axisTopic invalid", rawText };
    }

    const intentOk =
      intent === "qa_first" ||
      intent === "qa_more" ||
      intent === "need_lines" ||
      intent === "clarify" ||
      intent === "chitchat";
    if (!intentOk) return { ok: false, error: "llm_topic: intent invalid", rawText };

    // 主語不明の線引きは clarify（= 主語確認）へ
    let finalIntent: LlmTopicIntent = intent;
    if (finalIntent === "need_lines" && subjectTopic === "") finalIntent = "clarify";

        const fixedTopicsNow =
      subjectTopic === ""
        ? []
        : uniq([subjectTopic, ...topicsNow])
            .filter((t) => allowSet.has(t))
            .filter((t) => !TOPIC_DENYLIST.has(t))
            .slice(0, 3);


    const decision: LlmTopicDecision = {
      subjectTopic,
      axisTopic: auditAxis ? TOPIC_TAX_AUDIT : "",
      auditAxis,
      topicsNow: fixedTopicsNow,
      intent: finalIntent,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
      reason,

      nudgeLines,
      nudgeReason,

      shiftCue,
      shiftCueReason,
    };

    return { ok: true, decision, rawText };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "llm_topic: failed", rawText };
  }
}
