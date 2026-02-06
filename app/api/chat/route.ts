// app/api/chat/route.ts
import { generateAnswer } from "../../lib2/ai/generateAnswer";
import type { PromptParts } from "../../lib2/ai/prompt";
import { judgeGuardrails } from "../../lib2/guardrails";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// NEW: 37.2 split
import { inferTopics, inferTopicsDebug, inferTopicFromHistory, isWeakUtterance, isFollowupOnlyText } from "../../lib2/topicSignals";
import { decideAxisSubject, inferLensWithContext, TOPIC_TAX_AUDIT, AUDIT_OVERLAY_TOPICS, type Lens } from "../../lib2/topicDecision";
// NEW: LLM topic decision (39)
import { decideTopicByLLM } from "../../lib2/ai/topicDecisionLlm";
import { inferLensByLLM } from "../../lib2/ai/inferLensByLLM";

export const runtime = "nodejs";

/** ===== constants ===== */
const LINES_PREFACE_TAG = "【Lines前置き】"; // knowledge_items(kind=qa) の title に入れると followup_lines 前置きに使われる

const SERVICE_ASSUMPTION_RULES: string[] = [
  "重要：このサービスは『顧問税理士がいる前提』で答える。顧問税理士がいない前提の案内（例：税理士の有無確認・選任の勧め・無い場合の段取り）は原則書かない。",
  "税務調査の対応は『顧問税理士と連携して進める前提』で、社長がやること/税理士がやることを分けて書く。",
  "例外：ユーザーが明示的に『顧問税理士がいない』と言った場合だけ、その前提で答える。",
];

const INTERNAL_LEAK_RE = /(未登録|ここに|\bDB\b|データベース|育成知見|\binternal\b|\bTODO\b|開発用)/i;

function isLeakyLine(text: string): boolean {
  return INTERNAL_LEAK_RE.test(String(text ?? ""));
}


/** ===== small utils ===== */
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
function clampForContext(s: string, n: number) {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n) + "…";
}
function dbgHead(s: string, n = 80) {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n) + "…";
}

// 見えない混入（ゼロ幅・全角スペース等）も疑えるように、末尾のコードポイントを可視化
function codepointsTail(s: string, n = 24): string {
  const arr = Array.from(String(s ?? ""));
  const tail = arr.slice(Math.max(0, arr.length - n));
  return tail
    .map((ch) => {
      const cp = ch.codePointAt(0);
      const hex = cp === undefined ? "??" : "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
      const visible = ch === " " ? "␠" : ch === "\n" ? "␤" : ch === "\t" ? "␉" : ch;
      return `${visible}:${hex}`;
    })
    .join(" ");
}

/** ===== types ===== */
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

type MsgMini = { id: string; role: "user" | "assistant"; content: string; created_at: string };

type StanceAD = "attack" | "defense";
type RoleKL = "user" | "internal";

type KnowledgeLine = {
  id: string;
  topic: string;
  stance: StanceAD;
  lens: Lens;
  role?: RoleKL;
  text: string;
  priority: number;
};

type KnowledgeItem = {
  id: string;
  kind: "rule" | "qa" | "example";
  topic: string;
  title: string;
  content: string;
  amounts: any;
  conditions: any;
  priority: number;
};

// ===== Debug meta =====
type PickedQaMeta = { id: string; title: string; priority: number; topic: string };
type PickedLineMeta = { id: string; topic: string; lens: Lens; stance: StanceAD; priority: number; role?: RoleKL };

type DebugMeta = {
  picked_qa?: PickedQaMeta[];
  picked_lines?: PickedLineMeta[];

  axis_topic?: string;
  subject_topic?: string;
  audit_axis?: boolean;

  borrowed_prev_topic?: boolean;
  weak_utterance?: boolean;
  prev_user_head?: string;
  prev_user_len?: number;

  qa_keypoint_used_title?: string;
  qa_keypoint_used?: string;
  qa_pick_reason?: string;

  kb_bucket_counts?: { subject: number; audit: number; other: number };
  picked_kb_items?: Array<{
    id: string;
    kind: "rule" | "qa" | "example";
    topic: string;
    title: string;
    priority: number;
  }>;

  // topic debug
  topic_normalized?: string;
  topic_hits?: any; // TopicHit[] を使うなら型付け可（循環回避で any）
  topic_raw?: string;
  topic_raw_json?: string;
  topic_codepoints_tail?: string;

    // ===== lens debug (NEW) =====
  lens_rule?: Lens;
  lens_llm?: Lens;
  lens_llm_confidence?: number;
  lens_pre?: Lens;
  lens_final?: Lens;


  // followup_lines cooldown
  prev_debug_path?: string;
  prev_debug_lens?: string;
  lines_cooldown_applied?: boolean;
  lines_keep_reason?: string;
    // lines safety guards
  lines_blocked_no_subject?: boolean;
  lines_suppressed_short_ack?: boolean;

  tax_audit_sticky_reason?: string;

  // NEW: clarify / implicit shift (CSVに出したければ admin export に後で足せばOK)
  clarify_prev_answer?: boolean;
  clarify_term?: string;
  clarify_matched?: string;
  implicit_shift?: boolean;
  implicit_shift_unstick?: boolean;
  audit_essence_injected?: boolean;

    // topic mode / llm decision
  topic_mode?: "regex" | "llm";
  llm_topic_ok?: boolean;
  llm_topic_error?: string;
  llm_topic_raw?: string;
  llm_intent?: string;
  llm_confidence?: number;
  llm_reason?: string;

    // ===== answer sanity (server side) =====
  answer_has_rice?: boolean;
  answer_has_salt?: boolean;
  answer_has_attack_plain?: boolean;
  answer_has_defense_plain?: boolean;
  answer_head?: string;

  built_head?: string;
};

type DebugTrace = {
  convId: string;
  userId: string;
  messageHead: string;
  topicsNow: string[];
  inferredTopic: string; // axis としてログに出す（= 税務調査になりやすい）
  lens: Lens;
  followupExplicit: boolean;
  followupPhase: boolean;
  lineRequest: boolean;
  shifted: boolean;
  followup: boolean;
  forceNormalAnswer: boolean;
  usedKnowledge: boolean;
  usedLinesPick: boolean;
  path: "followup_lines" | "followup_kb" | "followup_fallback" | "normal_llm";
  meta?: DebugMeta;
};

/** ===== normalize ===== */
function normalizeDialect(x: string): Dialect {
  return x === "standard" ? "standard" : "kansai";
}
function normalizeStance(x: string): Stance {
  return x === "sanbo" ? "sanbo" : "zubatto";
}

/** ===== clarify / implicit shift helpers ===== */
function hasTaxAuditWordsLite(text: string): boolean {
  const t = (text ?? "").trim();
  return /(税務調査|調査官|国税|税務署|反面調査|更正|修正申告|過少申告|重加算|質問検査|任意調査|臨場|調査(対応|対策|で)|税務署(から|来)|国税(から|来))/i.test(
    t
  );
}

function isShortAckLike(message: string): boolean {
  const m = (message ?? "").trim();
  if (!m) return false;

  // いわゆる「続きちょうだい」系（雑でもOK）
  if (/^(よろ|よろしく|よろしこ|よろ！|よろー|よろです！|頼む|たのむ|お願い|おねがい|おねげぇ|つづき|続き)$/.test(m)) return true;

  // ひらがなだけの短文（例：おねげぇ、よろ、ほな、など）を広めに拾う
  if (m.length <= 6 && /^[ぁ-んー！!？?]+$/.test(m)) return true;

  return false;
}


function startsWithContinuationPrefix(message: string): boolean {
  const m = (message ?? "").trim();
  return /^(それ|その|じゃあ|じゃ|ほな|で|なら|今の|さっき|続き|つづき|あと|それで)/.test(m);
}

function hasGenericContinuationCue(message: string): boolean {
  const m = (message ?? "").trim();
  return /(どうすれば|どうしたら|どう対応|何したら|何から|結局|つまり|次(は)?|このあと|具体的に|要は)/.test(m);
}

// followupOnly（短文）扱いを抑える：質問っぽい短文は followupOnly にしない
function looksQuestionish(message: string): boolean {
  const m = (message ?? "").trim();
  if (!m) return false;
  if (/[?？]/.test(m)) return true;
  return /(何|なに|どう|どっち|どちら|いつ|どこ|だれ|誰|なぜ|なんで|意味|どゆ|どういう|って|とは)/.test(m);
}

function tokens3(s: string): string[] {
  return Array.from((s ?? "").matchAll(/[一-龠ぁ-んァ-ンA-Za-z0-9]{3,}/g)).map((m) => m[0]);
}

function extractClarifyTerm(message: string): string | null {
  const raw = (message ?? "").trim();
  if (!raw) return null;

  // 末尾の記号を落とす
  const s = raw.replace(/[！!。．…]+$/g, "").replace(/[?？]+$/g, "").trim();
  if (!s) return null;

  // 典型：Xってなに / Xてなに / Xとは / Xって？
  const m1 = s.match(/^(.+?)(?:って|て|とは)\s*(?:何|なに|どういう意味|どういうこと|どゆこと|どゆ意味|意味)$/);
  if (m1?.[1]) return m1[1].trim();

  const m2 = s.match(/^(.+?)(?:って|て|とは)\s*$/);
  if (m2?.[1]) return m2[1].trim();

  // 単語だけ：按分？ / 不課税？ みたいな “単体疑問”
  const solo = s.trim();
  if (solo.length <= 10 && !/\s/.test(solo)) return solo;

  return null;
}

function normKey(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[\/\\・\.\-＿_]/g, ""); // スラッシュ等を消す（全角＿＋半角_ も）
}


function detectClarifyPrevAnswer(message: string, prevAssistantMessage: string | null): { ok: boolean; term: string; matched: string } {
  const prev = (prevAssistantMessage ?? "").trim();
  if (!prev) return { ok: false, term: "", matched: "" };

  const term = (extractClarifyTerm(message) ?? "").trim();
  if (!term) return { ok: false, term: "", matched: "" };

  // まずは素直に部分一致
  if (term.length >= 2 && prev.includes(term)) return { ok: true, term, matched: term };

    // ★追加：記号差（B/L vs BL など）を吸収して部分一致
  const prevK = normKey(prev);
  const termK = normKey(term);
  if (termK.length >= 2 && prevK.includes(termK)) return { ok: true, term, matched: term };

  // 次に token（3文字以上）で部分一致
  const ts = tokens3(term);
  const hit = ts.find((t) => t && prev.includes(t));
  if (hit) return { ok: true, term, matched: hit };

  return { ok: false, term, matched: "" };
}

function insertLineBeforeInquiry(answer: string, line: string): string {
  const a0 = String(answer ?? "").replace(/\r\n/g, "\n").trim();
  const l = String(line ?? "").trim();
  if (!a0 || !l) return a0;

  const lines = a0.split("\n");
  const idx = lines.findIndex((x) => x.trimStart().startsWith("🔎"));
  if (idx < 0) {
    return `${a0}\n\n${l}`.replace(/\n{3,}/g, "\n\n").trim();
  }

  // 既に同じ行が入ってたら重複させない
  if (lines.some((x) => x.trim() === l)) return a0;

  const head = lines.slice(0, idx);
  const tail = lines.slice(idx);

  const out: string[] = [...head];
  if (out.length > 0 && out[out.length - 1].trim()) out.push("");
  out.push(l, "");
  out.push(...tail);

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function auditEssenceOneLine(dialect: Dialect, stance: Stance): string {
  // B案：固定テンプレ1行（カード混ぜない）
  if (dialect === "kansai" && stance === "sanbo") return "※ 税務調査目線：形式より実態。一貫性と証拠で見られますわ。";
  if (dialect === "standard" && stance === "sanbo") return "※ 税務調査目線：形式より実態。一貫性と証拠で見られます。";
  // zubatto（丁寧語なし）
  return "※ 税務調査目線：形式より実態。一貫性と証拠で見られる。";
}

/** ===== rules builders ===== */
function buildOutputRules(params: { allowAttackDefenseDetail: boolean }): string[] {
  const { allowAttackDefenseDetail } = params;

  const detailRule = allowAttackDefenseDetail
    ? "ユーザーが深掘りを求めた場合は、**必ず** 見出し付きで『🍚攻め』『🧂守り』の詳細ブロックを出す。『🥄ちょうど良いライン』や要点の繰り返しは禁止。"
    : "初回回答では『🍚攻め』『🧂守り』は出さない。判断軸として『🥄ちょうど良いライン』と要点の説明だけに限定する。";

  return [
    "Markdownの見出し（##、###など）は使わない。",
    "見出しラベルは固定：『🥄ちょうど良いライン』『✅要点』『⚠️注意』『🔎確認』。",
    "初回は『🥄ちょうど良いライン』→『✅要点』の順で書く。",
    detailRule,
    "『🍚攻め』『🧂守り』を出した場合は決めゼリフは禁止。",
    "決めゼリフはサーバ側で付与する。",
    "🔎確認は返事いらんメモとして1行のみ。",
  ];
}

function buildAmbiguityBoostRules(message: string): string[] {
  const m = (message ?? "").trim();
  const hasTaxWords =
    /税|経費|損金|消費税|源泉|役員|給与|交際費|棚卸|売上|請求|領収|仕訳|法人|個人|青色|調査|否認|事業|私用|按分/.test(m);
  if (!m) return [];

  const hasSafety = /安全度|安全性|リスク|危険|グレー|大丈夫/.test(m);
  if (!hasSafety) return [];

  return [
    "重要：ユーザーの『安全度/安全性/大丈夫？/リスク』は、まず税務・経営の安全性として解釈する（否認リスク/税務調査リスク/資金繰り・意思決定リスク）。一般的な安全（健康/事故/防犯）に逸れない。",
    "『安全度』は必ず『税務上の安全度（否認リスク/税務調査リスク）』として 高/中/低 の3段階で返す。",
    hasTaxWords
      ? "ユーザー文面が税務寄りなら、🔎は原則出さない（トーク消費を避ける）。"
      : "一般論の可能性が残る時だけ、末尾の🔎は『税務・経営前提で答えた。前提が違うなら言って』の1行メモにする（YES/NOで聞かない）。",
  ];
}

/** ===== style ===== */
const FORBIDDEN_POLITE = ["です", "ます", "でした", "ません", "ございます", "ください", "いただ", "おります", "でしょう", "ますか", "ですか"];
function forbiddenFor(_dialect: Dialect, stance: Stance): string[] | null {
  if (stance === "zubatto") return FORBIDDEN_POLITE;
  return null;
}
function findForbiddenHits(text: string, forbidden: string[]): string[] {
  const hits: string[] = [];
  for (const w of forbidden) {
    if (text.includes(w)) hits.push(w);
  }
  return Array.from(new Set(hits));
}

function buildStyleRules(dialect: Dialect, stance: Stance): string[] {
  const rules: string[] = [];

  if (stance === "zubatto") {
    rules.push("人格はパーソナルジムの人気トレーナー。あめと鞭を使い分ける。");
    rules.push("結論ファーストで短くズバっと。余計な前置きは削る。");
    rules.push("口調はタメ口。丁寧語（です/ます）は禁止。");
    rules.push("文章は短文中心。1文は40文字以内を目安にする。");
    rules.push("箇条書きは最大3行まで。理由は2行以内にまとめる。");
    rules.push("言いにくいこともハッキリ言う（断定できない所は断定しない）。");
  } else {
    rules.push("人格は参謀。論点整理→選択肢→おすすめ→次のアクションで導く。");
    rules.push("情報が足りない所は、結論を急がず条件分岐で整理する。");
  }

  if (dialect === "kansai") {
    if (stance === "sanbo") {
      rules.push(
        "関西弁の参謀は“丁寧な関西弁”で統一する（例：〜でっせ／〜でっしゃろ／〜ですわ／〜してはります／〜しときなはれ／〜してもろて）。タメ口（や/で/やな/やろ/ちゃう）は極力使わない。"
      );
      rules.push("標準語の敬語（〜です/〜ますの“標準語文体”）は禁止。丁寧語を使う場合も関西の言い回しで統一する。");
      rules.push("文末の7割以上を丁寧語で終える。『や・で』で終えるのは禁止に近い（例外はツッコミ1回まで）。");
    } else {
      rules.push("語彙・語尾は関西弁の口語。丁寧語（です/ます）は禁止。");
      rules.push("語尾例：や／で／やな／やろ／ちゃう／せやな／アウト寄り／OK寄り");
    }
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

/** ===== conversation ===== */
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

async function buildConversationContext(params: { db: any; convId: string }): Promise<string[]> {
  const { db, convId } = params;
  const lines: string[] = [];

  const { data: conv } = await db.from("conversations").select("summary, summary_updated_at, created_at").eq("id", convId).maybeSingle();
  const summary = (conv?.summary ?? "").trim();
  if (summary) lines.push(`【会話要約】${clampForContext(summary, 400)}`);

  const N = Number(process.env.CHAT_CONTEXT_TURNS || "16");
  const { data: rows } = await db
    .from("messages")
    .select("id, role, content, created_at")
    .eq("conversation_id", convId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
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

/** ===== followup 判定 ===== */
function isInFollowupPhase(prevAssistantMessage: string | null): boolean {
  const s = prevAssistantMessage ?? "";
  return s.includes("🍚攻め") && s.includes("🧂守り");
}

function isLineRequest(message: string): boolean {
  const m = (message ?? "").trim();

  // 基本合言葉
  if (/(攻め\s*\/\s*守り|攻め\s*守り|攻めと守り|攻め守りで)/.test(m)) return true;
  if (/(攻めのライン|守りのライン)/.test(m)) return true;

  // お遊び要素：さじかげん
  // 「さじかげん」「さじかげんよろ」「さじかげんで」「さじかげん頼む」等を拾う
  if (/さじかげん/.test(m)) return true;

  return false;
}


// 「初手で🍚🧂を出して良い」ほど明示的な要求だけ拾う（段階出しの本丸）
function isLineDetailRequest(message: string): boolean {
  const m = (message ?? "").trim();
  return /(攻め|守り|攻守|上限|限界|安全ライン|レンジ|幅|いくら|なんぼ|金額|いくつまで|どんぐらい)/.test(m);
}

function isAmountAsk(message: string): boolean {
  const m = (message ?? "").trim();
  return /(いくら|なんぼ|金額|上限|限界|レンジ|幅|いくつまで|どこまで|ギリ|安全|セーフ|アウト|グレー)/.test(m);
}

function adjustLensByConversation(params: {
  lens: Lens;
  message: string;
  subjectTopic: string;
  axisTopic: string;
  llmIntent: string;
}): Lens {
  const { lens, message, subjectTopic, axisTopic, llmIntent } = params;
  const m = (message ?? "").trim();
  const topic = (subjectTopic || axisTopic || "").trim();

  // clarify / qa_more は “金額レンジ” で殴らない（会話がズレる）
  if (llmIntent === "clarify" || llmIntent === "qa_more") {
    if (lens === "amount") return "substance";
  }

  // amount は「金額を聞かれた時だけ前に出す」
  if (lens === "amount" && !isAmountAsk(m)) return "substance";

  // 外注：毎月同額＝金額より「実態（指揮命令/成果/代替性/裁量）」が主戦場
  if (topic === "外注" && /(毎月|月々|同じ金額|定額|固定)/.test(m) && !isAmountAsk(m)) {
    return "substance";
  }

  // 制度ワードが強い時は system に寄せる（インボイス/源泉/登録/規程など）
  if (/(インボイス|登録|未登録|適格|源泉|支払調書|請求書|契約書|規程|届出|要件)/.test(m)) {
    return "system";
  }

  return lens;
}


function topicShiftLikelyLite(prevUser: string | null, cur: string): boolean {
  const prev = (prevUser ?? "").trim();
  const now = (cur ?? "").trim();
  if (!prev || !now) return false;

  const tokens = (s: string) => Array.from(s.matchAll(/[一-龠ぁ-んァ-ンA-Za-z0-9]{3,}/g)).map((x) => x[0]);
  const a = tokens(prev);
  const b = tokens(now);
  if (a.length === 0 || b.length === 0) return false;

  const setA = new Set(a);
  const overlap = b.some((t) => setA.has(t));
  return !overlap;
}

function wantsAttackDefenseDetail(message: string, prevUserMessage: string | null): boolean {
  const m = (message ?? "").trim();
  const prev = (prevUserMessage ?? "").trim();

  const strong = /攻め|守り|攻守|上限|限界|どこまで|ギリ|グレー|危険|安全ライン|幅|レンジ|強め|弱め|リスク高|リスク低/.test(m);
  if (strong) return true;

  const followupCue =
    /(教えて|おしえて|詳しく|詳細|具体|もう少し|もっと|続き|つづき|お願い|おねがい|頼む|たのむ|よろしく|再度|もう一回|もういちど|さっき|よろしこ)/.test(
      m
    );

  const veryShort = m.length <= 2 || /^[\.\-ー…\?？!！wｗ]+$/.test(m);

  const topicShiftLikely = (() => {
    if (!prev) return false;
    const tokens = (s: string) => Array.from(s.matchAll(/[一-龠ぁ-んァ-ンA-Za-z0-9]{3,}/g)).map((x) => x[0]);
    const a = tokens(prev);
    const b = tokens(m);
    if (a.length === 0 || b.length === 0) return false;
    const setA = new Set(a);
    const overlap = b.some((t) => setA.has(t));
    return !overlap;
  })();

  // 「よろ」等の短文は followupOnly/isShortAckLike 側で拾う（ここで explicit にしない）
  if (followupCue) return true;
  if (veryShort && !topicShiftLikely) return true;

  return false;
}

/** ===== knowledge retrieval ===== */
async function retrieveGlobalRules(params: { db: any }): Promise<KnowledgeItem[]> {
  const { db } = params;
  const { data, error } = await db
    .from("knowledge_items")
    .select("id, kind, topic, title, content, amounts, conditions, priority")
    .eq("is_active", true)
    .eq("kind", "rule")
    .eq("topic", "制度基準")
    .order("priority", { ascending: false })
    .limit(20);
  if (error) return [];
  return (data ?? []) as KnowledgeItem[];
}

async function fetchAvailableTopics(db: any): Promise<string[]> {
  const out = new Set<string>();

  try {
    const { data } = await db.from("knowledge_items").select("topic").eq("is_active", true).limit(500);
    for (const r of (data ?? []) as any[]) {
      const t = String(r?.topic ?? "").trim();
      if (t) out.add(t);
    }
  } catch {}

  try {
    const { data } = await db.from("knowledge_lines").select("topic").eq("is_active", true).limit(500);
    for (const r of (data ?? []) as any[]) {
      const t = String(r?.topic ?? "").trim();
      if (t) out.add(t);
    }
  } catch {}

  out.delete("GLOBAL");
  out.add(TOPIC_TAX_AUDIT);

  return Array.from(out);
}


function messageTokens3(s: string): string[] {
  return Array.from((s ?? "").matchAll(/[一-龠ぁ-んァ-ンA-Za-z0-9]{3,}/g)).map((m) => m[0]);
}

async function retrieveKnowledgeByBuckets(params: {
  db: any;
  message: string;
  auditAxis: boolean;
  subjectTopic: string;
  topicsNow: string[];
  maxTotal?: number;
}): Promise<KnowledgeItem[]> {
  const { db, auditAxis, subjectTopic, topicsNow } = params;

  const maxTotal = Math.max(1, Math.min(20, params.maxTotal ?? 10));

  const wantsBuckets = auditAxis && Boolean(subjectTopic);

  const quotaSubject = wantsBuckets ? 4 : 0;
  const quotaAudit = wantsBuckets ? 3 : 0;
  const quotaOther = wantsBuckets ? Math.max(0, maxTotal - quotaSubject - quotaAudit) : maxTotal;

  const uniqById = (xs: KnowledgeItem[]) => {
    const seen = new Set<string>();
    const out: KnowledgeItem[] = [];
    for (const it of xs) {
      if (!it?.id) continue;
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      out.push(it);
    }
    return out;
  };

  const fetchTopic = async (topic: string, limit: number): Promise<KnowledgeItem[]> => {
    if (!topic || limit <= 0) return [];
    const { data, error } = await db
      .from("knowledge_items")
      .select("id, kind, topic, title, content, amounts, conditions, priority")
      .eq("is_active", true)
      .eq("topic", topic)
      .order("priority", { ascending: false })
      .limit(limit);
    if (error) return [];
    return (data ?? []) as KnowledgeItem[];
  };

  const fetchTopics = async (topics: string[], limit: number): Promise<KnowledgeItem[]> => {
    const ts = Array.from(new Set((topics ?? []).filter(Boolean)));
    if (ts.length === 0 || limit <= 0) return [];
    const { data, error } = await db
      .from("knowledge_items")
      .select("id, kind, topic, title, content, amounts, conditions, priority")
      .eq("is_active", true)
      .in("topic", ts)
      .order("priority", { ascending: false })
      .limit(limit);
    if (error) return [];
    return (data ?? []) as KnowledgeItem[];
  };

  const subjectItems = wantsBuckets ? await fetchTopic(subjectTopic, quotaSubject) : [];
  const auditItems = wantsBuckets ? await fetchTopic(TOPIC_TAX_AUDIT, quotaAudit) : [];

  const otherTopics = (topicsNow ?? []).filter((t) => t && t !== subjectTopic && t !== TOPIC_TAX_AUDIT);

  let otherItems: KnowledgeItem[] = [];
  if (wantsBuckets) {
    otherItems = await fetchTopics(otherTopics, quotaOther);
  } else {
  // LLM主導。other は広めに拾う
  otherItems = await fetchTopics([], maxTotal);
}


  let merged = uniqById([...subjectItems, ...auditItems, ...otherItems]).slice(0, maxTotal);

  if (merged.length < maxTotal) {
    const poolTopics = Array.from(new Set([subjectTopic, ...(auditAxis ? [TOPIC_TAX_AUDIT] : []), ...otherTopics].filter(Boolean)));
    const fill = await fetchTopics(poolTopics, maxTotal - merged.length);
    merged = uniqById([...merged, ...fill]).slice(0, maxTotal);
  }

  return merged;
}

async function retrieveKnowledgeLines(params: {
  db: any;
  topic: string;
  lens: Lens;
  messageForMatch: string;
}): Promise<{ attack: KnowledgeLine | null; defense: KnowledgeLine | null }> {
  const { db, topic, lens, messageForMatch } = params;

  const run = async (withRole: boolean, lensArg: Lens) => {
    let q = db
      .from("knowledge_lines")
      .select("id, topic, stance, lens, role, text, priority")
      .eq("is_active", true)
      .eq("topic", topic)
      .eq("lens", lensArg)
      .in("stance", ["attack", "defense"])
      .order("priority", { ascending: false })
      .limit(30);
    if (withRole) q = q.eq("role", "user");
    return q;
  };

  const tryFetch = async (lensArg: Lens) => {
    let data: any[] | null = null;
    let error: any = null;

    const res = await run(true, lensArg);
    const r = await res;
    data = r?.data ?? null;
    error = r?.error ?? null;

    const msg = String(error?.message ?? "");
    const missingRole = /role/i.test(msg) && /(column|does not exist|unknown)/i.test(msg);

    if (error && missingRole) {
      const res2 = await run(false, lensArg);
      const r2 = await res2;
      data = r2?.data ?? null;
      error = r2?.error ?? null;
    }
    if (error || !data) return [] as KnowledgeLine[];
    return data as KnowledgeLine[];
  };

  const lensFallbacks: Lens[] =
    topic === TOPIC_TAX_AUDIT
      ? lens === "amount"
        ? ["substance", "system", "amount"]
        : ["substance", "system", "amount"]
      : [lens, "substance", "system", "amount"];

  const tokens = messageTokens3(messageForMatch);

  
  const scoreText = (text: string) => {
    
    const t = (text ?? "").toLowerCase();
    let score = 0;
    for (const w of tokens) if (w && t.includes(w.toLowerCase())) score += 1;
    return score;
  };

  for (const lf of lensFallbacks) {
    const rows = await tryFetch(lf);
    if (!rows || rows.length === 0) continue;

    const pickOne = (stance: StanceAD) => {
  // ★中身が空/短すぎる行を除外（事故防止）
  const minLen = 8; // 好みで。まずは8〜12くらいが無難
  const candidates = rows
    .filter((r) => r.stance === stance)
    .filter((r) => !isLeakyLine(r.text))                 // ★追加：事故行除外
    .filter((r) => String(r.text ?? "").trim().length >= minLen);

  if (candidates.length === 0) return null;

  const scored = candidates.map((r) => ({ r, s: scoreText(r.text) }));
  scored.sort((a, b) => b.s - a.s || (b.r.priority ?? 0) - (a.r.priority ?? 0));
  return scored[0]?.r ?? null;
};

    const attack = pickOne("attack");
    const defense = pickOne("defense");
    if (attack && defense) return { attack, defense };
  }

  return { attack: null, defense: null };
}

function pickBestQaForMessage(items: KnowledgeItem[], message: string): KnowledgeItem | null {
  const m = (message ?? "").trim();
  const qas = (items ?? []).filter((x) => x.kind === "qa");
  if (qas.length === 0) return null;

  const intakeHit = /(最初|初動|電話|連絡|窓口|誰に)/.test(m);
  if (intakeHit) {
    const hit = qas.find((q) => /(最初|連絡|電話|窓口|誰に)/.test((q.title ?? "") + " " + (q.content ?? "")));
    if (hit) return hit;
  }

  const sorted = [...qas].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return sorted[0] ?? null;
}

function pickBestQaPreferSubject(params: {
  items: KnowledgeItem[];
  message: string;
  subjectTopic?: string | null;
  axisTopic?: string | null;
}): { qa: KnowledgeItem | null; reason: string } {
  const { items, message, subjectTopic, axisTopic } = params;
  const qas = (items ?? []).filter((x) => x.kind === "qa");
  if (qas.length === 0) return { qa: null, reason: "no_qas" };

  const subject = (subjectTopic ?? "").trim();
  const axis = (axisTopic ?? "").trim();

  if (subject) {
    const subjectItems = qas.filter((q) => q.topic === subject);
    const qa = pickBestQaForMessage(subjectItems, message);
    if (qa) return { qa, reason: `prefer_subject:${subject}` };
  }

  if (axis) {
    const axisItems = qas.filter((q) => q.topic === axis);
    const qa = pickBestQaForMessage(axisItems, message);
    if (qa) return { qa, reason: `fallback_axis:${axis}` };
  }

  return { qa: pickBestQaForMessage(qas, message), reason: "fallback_any" };
}

function qaToKeyPointRule(qa: KnowledgeItem, maxLines = 2): string {
  const text = (qa?.content ?? "").replace(/\r\n/g, "\n");
  const lines = text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const picked: string[] = [];
  for (const l of lines) {
    const t = l.replace(/^[-・]\s*/, "").trim();
    if (!t) continue;
    if (t.length > 140) continue;
    picked.push(t);
    if (picked.length >= maxLines) break;
  }

  const body = picked.length ? picked : [lines[0]?.slice(0, 120) ?? ""].filter(Boolean);
  const joined = body.join(" / ").trim();

  return `重要：以下の実務要点を必ず反映する（出典：QA「${qa.title}」）。→ ${joined}`;
}

/** ===== knowledge formatting ===== */
function formatKnowledgeBlock(items: KnowledgeItem[]): string {
  if (!items || items.length === 0) return "";

  const lines: string[] = [];
  lines.push("【育成知見（最優先）】");
  lines.push("※一般論より優先して扱う。金額の目安は育成知見を採用する。");

  for (const it of items) {
    const tag = it.kind === "rule" ? "[Rule]" : it.kind === "qa" ? "[Q&A]" : "[Example]";
    lines.push(`${tag} ${it.title}`);
    lines.push(`- ${it.content.replace(/\r\n/g, "\n").split("\n").join("\n- ")}`);
    if (it.amounts && Object.keys(it.amounts).length > 0) lines.push(`- 目安金額: ${JSON.stringify(it.amounts)}`);
  }
  return lines.join("\n");
}

/** ===== followup kb builder ===== */
type AttackDefensePick = { attack: string; defense: string; pitfall?: string | null };

function pickFirstNonEmpty(...xs: Array<string | null | undefined>): string | null {
  for (const x of xs) {
    const t = (x ?? "").trim();
    if (t) return t;
  }
  return null;
}

function extractAttackDefenseFromContent(content: string): AttackDefensePick | null {
  const text = (content ?? "").replace(/\r\n/g, "\n");
  const defense = pickFirstNonEmpty(text.match(/^[ \t]*守り[:：]\s*(.+)\s*$/m)?.[1]);
  const attack = pickFirstNonEmpty(text.match(/^[ \t]*攻め[:：]\s*(.+)\s*$/m)?.[1]);
  if (!attack || !defense) return null;

  let pitfall: string | null = null;
  const m = text.match(/【⚠️地雷】([\s\S]*?)(【|$)/);
  if (m?.[1]) {
    const lines = m[1]
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const bullet = lines.find((l) => l.startsWith("-") || l.startsWith("・"));
    if (bullet) pitfall = bullet.replace(/^[-・]\s*/, "").trim();
  }

  return { attack, defense, pitfall };
}

function buildFollowupAnswerFromKbWithPick(items: KnowledgeItem[]): { text: string; picked: KnowledgeItem } | null {
  for (const it of items ?? []) {
    const ad = extractAttackDefenseFromContent(it.content);
    if (!ad) continue;

    const lines: string[] = [];
    lines.push(`🍚攻め：${ad.attack}`);
    lines.push(`🧂守り：${ad.defense}`);
    if (ad.pitfall) lines.push(`⚠️地雷メモ：${ad.pitfall}`);
    return { text: lines.join("\n").trim(), picked: it };
  }
  return null;
}

function buildFollowupAnswerFromLines(params: { attack: KnowledgeLine | null; defense: KnowledgeLine | null }): string | null {
  const at = (params.attack?.text ?? "").trim();
  const df = (params.defense?.text ?? "").trim();
  if (!at || !df) return null;
  return `🍚攻め：${at}\n🧂守り：${df}`.trim();
}


function fallbackAttackDefense(topic: string, lens: Lens): { attack: string; defense: string } {
  const t = (topic ?? "").trim();
  if (lens === "amount") {
    return {
      attack: `${t ? `${t}の` : ""}金額は“運用と説明設計”が固まってる前提で、相場レンジの上側まで寄せる。回数・目的・相手・成果の一貫性を説明できる状態にしてから攻める。`,
      defense: `${t ? `${t}の` : ""}金額は控えめに置く。1回あたり・1人あたりで上限ルールを決め、例外は理由メモ必須。迷ったら“少額×一貫性”で守る。`,
    };
  }
  if (lens === "system") {
    return {
      attack: `${t ? `${t}は` : ""}規程・社内ルールを整備して“制度要件を満たした前提”で攻める。必要書類（規程/申請/精算/承認）の型を固定して、運用で勝つ。`,
      defense: `${t ? `${t}は` : ""}制度面の抜けを潰すのを最優先。規程が無い/運用が曖昧なら、先にルール整備→運用実績→次に攻める。`,
    };
  }
  return {
    attack: `${t ? `${t}は` : ""}実態と証拠が揃ってる前提で攻める。誰に・何の目的で・どんな成果に繋がったかを“行メモ”で残して、説明力で勝つ。`,
    defense: `${t ? `${t}は` : ""}領収書だけの運用は捨てる。相手・目的・成果のメモ、関連資料、承認の流れを先に固めてから進める。`,
  };
}

/** ===== line preface QA picker ===== */
function pickLinesPrefaceQa(items: KnowledgeItem[]): KnowledgeItem | null {
  const qas = (items ?? []).filter((x) => x.kind === "qa" && (x.title ?? "").includes(LINES_PREFACE_TAG));
  if (qas.length === 0) return null;
  qas.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return qas[0];
}

function buildLinesPreamble(params: {
  topic: string;
  axisTopic: string;
  dialect: Dialect;
  stance: Stance;
  qa: KnowledgeItem | null;
}): { text: string; usedQaId?: string } {
  const { topic, axisTopic, qa } = params;

  if (qa && qa.content) {
    const lines = qa.content
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 3);

    const out: string[] = [];
    if (lines[0]) out.push(`✅要点 ${lines[0]}`);
    for (const l of lines.slice(1)) out.push(`- ${l}`);
    return { text: out.join("\n").trim(), usedQaId: qa.id };
  }

  const isAuditAxis = axisTopic === TOPIC_TAX_AUDIT;

  if (topic === "交際費" && isAuditAxis) {
    return {
      text: [
        "✅要点 🍚は通す条件、🧂は地雷回避。",
        "- 調査は「相手・目的・成果・証拠」の整合性を突く。",
        "- 現金手渡し/領収書なし/私的混在は一発で揉める。",
      ].join("\n"),
    };
  }
  if (isAuditAxis) {
    return {
      text: [
        "✅要点 🍚は主張が通る条件、🧂は揉めない守り。",
        "- 税務調査は「形式より実態」「一貫性」を見る。",
        "- 聞かれた範囲で勝つ（余計な情報は出さない）。",
      ].join("\n"),
    };
  }
  return {
    text: [
      "✅要点 🍚は通す条件、🧂は地雷回避。",
      "- 相手・目的・成果をメモで残すと説明が強い。",
      "- 迷ったら少額×一貫性で守る。",
    ].join("\n"),
  };
}

/** ===== output shaping / postprocess ===== */
function hasThreePatterns(answer: string): boolean {
  const hasAttack = answer.includes("🍚攻め");
  const hasDefense = answer.includes("🧂守り") || answer.includes("🧂 守り");
  return hasAttack && hasDefense;
}
function hasAttackOrDefense(answer: string): boolean {
  const hasAttack = answer.includes("🍚");
  const hasDefense = answer.includes("🧂守り") || answer.includes("🧂 守り");
  return hasAttack || hasDefense;
}
function isCatchphraseLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (t.includes("とはいえ")) return true;
  if (t.includes("税務の世界") && t.includes("答え")) return true;
  return false;
}

function extractSection(answer: string, head: "🥄" | "✅" | "⚠️" | "🔎"): string[] {
  const lines = answer.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inSec = false;
  const markers = ["🥄", "✅", "⚠️", "🔎", "🍚", "🧂"];
  for (const line of lines) {
    const t = line.trimStart();
    if (t.startsWith(head)) {
      inSec = true;
      out.push(line.trimEnd());
      continue;
    }
    if (inSec) {
      if (markers.some((m) => t.startsWith(m))) break;
      out.push(line.trimEnd());
    }
  }
  while (out.length > 0 && !out[out.length - 1].trim()) out.pop();
  return out;
}

function ensureLineBold(secLine: string[]): string[] {
  if (secLine.length === 0) return secLine;
  const out = [...secLine];
  if (out.some((l) => l.includes("**"))) return out;

  if (out.length === 1) {
    const line = out[0];
    const idx = Math.max(line.indexOf("："), line.indexOf(":"));
    if (idx >= 0 && idx < line.length - 1) {
      const head = line.slice(0, idx + 1);
      const tail = line.slice(idx + 1).trim();
      if (tail) out[0] = `${head}**${tail}**`;
      return out;
    }
    out[0] = `**${line.trim()}**`;
    return out;
  }
  for (let i = 1; i < out.length; i++) {
    const t = out[i].trim();
    if (!t) continue;
    out[i] = out[i].replace(/^(\s*)(.*?)(\s*)$/, (_m, p1, body, p2) => `${p1}**${String(body).trim()}**${p2}`);
    break;
  }
  return out;
}

function collapseInquiryToSingleLine(askLines: string[]): string[] {
  if (!askLines || askLines.length === 0) return askLines;
  const head = askLines[0].trim();
  const rest = askLines
    .slice(1)
    .map((l) => l.trim())
    .filter((x) => x.length > 0)
    .join(" ");
  if (!rest) return ["🔎確認 税務・経営前提で答えた。前提が違うなら言うてな。"];
  return [`${head} ${rest}`.trim()];
}

function enforceTemplate(answer: string): string {
  const a = answer.replace(/\r\n/g, "\n").trim();
  if (!a) return a;
  if (hasAttackOrDefense(a) && !hasThreePatterns(a)) {
  // 片側欠損はテンプレ側で直さない（= サーバが弾いて再生成させる）
  return a;
}
if (hasThreePatterns(a)) return a;

  const secLine = ensureLineBold(extractSection(a, "🥄"));
  const key = extractSection(a, "✅");
  const warn = extractSection(a, "⚠️");
  const ask = extractSection(a, "🔎");

  if (secLine.length === 0 || key.length === 0) return a;

  let askFixed = ask;
  if (askFixed.length > 0) {
    const filtered: string[] = [];
    let seen = false;
    for (const line of askFixed) {
      const t = line.trimStart();
      if (t.startsWith("🔎")) {
        if (seen) continue;
        seen = true;
      }
      filtered.push(line);
    }
    askFixed = filtered;
  }

  const parts: string[] = [];
  parts.push(...secLine, "");
  parts.push(...key);
  if (warn.length > 0) parts.push("", ...warn);
  if (askFixed.length > 0) parts.push("", ...collapseInquiryToSingleLine(askFixed));
  return parts.join("\n").trim();
}

function catchphraseFor(dialect: Dialect, stance: Stance): string {
  if (dialect === "kansai" && stance === "sanbo") {
    return "せやけど、税務の世界は答えひとつちゃいますさかい、🍚**『攻め守りで』**とか**『さじかげんよろ』**って言うてくれはったら、実務的なラインお出ししますわ。";
  }
  if (dialect === "standard" && stance === "sanbo") {
    return "とはいえ、税務の判断は白黒だけではありません。🍚**『攻め守りで』**や**『さじかげんよろしく』**と言っていただければ、実務的なラインを整理します。";
  }
  if (dialect === "kansai" && stance === "zubatto") {
    return "とはいえ、税務は一発正解ちゃう。🍚**『攻め守りで』**とか**『さじかげんよろ』**って言うたら、通しどころと地雷、はっきり出すで。";
  }
  return "とはいえ、税務の世界は答えはひとつじゃないよ。🍚**『攻め守りで』**とか**『さじかげんよろ』**って言ってくれたら、通しどころと地雷、はっきり出すよ。";
}

function forceCasual(text: string, dialect: Dialect): string {
  let s = (text ?? "").replace(/\r\n/g, "\n");

  s = s
    .replace(/ではありません/g, "ちゃう")
    .replace(/ではない/g, "ちゃう")
    .replace(/ありません/g, "ない")
    .replace(/ません/g, "ない")
    .replace(/ございました/g, "あった")
    .replace(/ございます/g, "ある")
    .replace(/しております/g, "してる")
    .replace(/おります/g, "る")
    .replace(/いただけ/g, dialect === "kansai" ? "もろえ" : "もらえ")
    .replace(/いただ/g, dialect === "kansai" ? "もろて" : "もらって")
    .replace(/でした/g, dialect === "kansai" ? "やった" : "だった")
    .replace(/です/g, dialect === "kansai" ? "や" : "だ")
    .replace(/ます/g, "")
    .replace(/ください/g, "して")
    .replace(/でしょう/g, dialect === "kansai" ? "やろ" : "だろ")
    .replace(/かもしれません/g, "かもな");

  s = s.replace(/し。/g, "する。").replace(/し\n/g, "する\n");
  return s;
}

function inquiryLine(dialect: Dialect, stance: Stance): string {
  if (dialect === "standard" && stance === "sanbo") return "🔎確認 税務・経営前提で回答しました。前提が違う場合はお知らせください。";
  if (dialect === "standard" && stance === "zubatto") return "🔎確認 税務・経営前提で答えた。前提が違うなら言って。";
  if (dialect === "kansai" && stance === "sanbo") return "🔎確認 税務・経営前提でお答えしましたで。前提が違うなら言うてくださいな。";
  return "🔎確認 税務・経営前提で答えたで。前提が違うなら言うてな。";
}

function inquiryLineWithAuditCTA(dialect: Dialect, stance: Stance, subjectTopic: string): string {
  const ex = `${subjectTopic}は税務調査で何を突かれやすい？`;

  if (stance === "sanbo") {
    if (dialect === "kansai") {
      return `🔎確認 税務・経営前提でお答えしましたで。必要でしたら「${ex}」みたいに投げてもろたら、調査目線のポイントも整理しますわ。`;
    }
    return `🔎確認 税務・経営前提で回答しました。必要でしたら「${ex}」の形でもう一段、税務調査目線のポイントを整理します。`;
  }

  if (dialect === "kansai") {
    return `🔎確認 税務・経営前提で答えたで。もし「${ex}」まで知りたかったら言うて。調査で刺さるポイントだけ整理する。`;
  }
  return `🔎確認 税務・経営前提で答えた。もし「${ex}」まで知りたければ言って。調査で刺さるポイントだけ整理する。`;
}

function stripInternalLeaks(text: string): string {
  let s = String(text ?? "").replace(/\r\n/g, "\n");

  s = s.replace(/[\(（][^()（）]*(未登録|ここに|DB|データベース|育成|internal|TODO)[^()（）]*[\)）]/gi, "");

  const ng = [/未登録/gi, /ここに/gi, /\bDB\b/gi, /データベース/gi, /育成知見/gi, /\binternal\b/gi, /\bTODO\b/gi, /開発用/gi];

  const lines = s.split("\n");
  const out = lines.filter((line) => !ng.some((re) => re.test(line)));
  s = out.join("\n").trim();

  if (!s) s = "🥄ちょうど良いライン：**一般論で整理する**。必要なら条件を揃えて深掘りする。";
  return s;
}

function postProcessAnswer(
  raw: string,
  dialect: Dialect,
  stance: Stance,
  opts: {
  usedKnowledge: boolean;
  allowAttackDefenseDetail: boolean;
  inquiryOverride?: string | null;
  llmIntent?: string | null; // "qa_first" | "qa_more" | "need_lines" | ...
}
): string {
  const llmIntent = safeStr(opts.llmIntent ?? "").trim();
  const usedKnowledge = opts.usedKnowledge;
  const allowAttackDefenseDetail = opts.allowAttackDefenseDetail;
  const inquiryOverride = (opts.inquiryOverride ?? "").trim();

  let a = String(raw ?? "").replace(/\r\n/g, "\n").trim();
  a = a.replace(/[\(（]最大[^)）]*[\)）]/g, "");

    // 🍚🧂 が混ざっても “早期return” しない（allowAttackDefenseDetail=false の時にサーバ側で削れるようにする）
  if (hasThreePatterns(a)) {
    const lines = a.split("\n");
    const out = lines.filter((line) => !isCatchphraseLine(line));
    a = out.join("\n").trim();
  }


  a = enforceTemplate(a);

  if (!allowAttackDefenseDetail) {
  a = a
    .split("\n")
    .filter((line) => {
      const t = line.trimStart();

      // 🍚🧂だけじゃなく、素の「攻め：」「守り：」も全部落とす（誤爆防止の本丸）
      if (t.startsWith("🍚攻め") || t.startsWith("🧂守り")) return false;
      if (/^(攻め|守り)\s*[:：]/.test(t)) return false;

      return true;
    })
    .join("\n")
    .trim();
} else {
  a = a
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("🥄"))
    .join("\n")
    .trim();
}


  const alreadyCatch = a.split("\n").some((line) => isCatchphraseLine(line));
  
// 誤爆ゼロ方針：qa_more では誘導を出さない（短文承諾が Lines に吸われるのを防ぐ）
const isQaFirst = llmIntent === "qa_first";
// const isQaMore = llmIntent === "qa_more";
// const isNeedLines = llmIntent === "need_lines";

if (usedKnowledge && !allowAttackDefenseDetail && !alreadyCatch) {
  // qa_first の時だけ、短いCTAを付ける（※🔎で始めない： inquiry置換に食われるため）
  if (isQaFirst) {
    const cta =
      dialect === "kansai"
        ? "👉 続き欲しければ「続き」。線引き（どこまで/上限）ならそれ言うて。"
        : "👉 続きが欲しければ「続き」。線引き（どこまで/上限）ならそれを言って。";

    // 既に👉がある場合は追加しない（重複防止）
    const hasCta = a.split("\n").some((line) => line.trimStart().startsWith("👉"));
    if (!hasCta) a = `${a}\n\n${cta}`.trim();
  }
  // qa_more / need_lines は誘導を付けない（誤爆防止）
}


  a = a
    .split("\n")
    .map((line) => {
      if (!line.trimStart().startsWith("🔎")) return line;
      return line.replace(/[（(]\s*はい\s*\/\s*いいえ\s*[)）]/g, "").trimEnd();
    })
    .join("\n")
    .trim();

  const desiredInquiry = inquiryOverride ? inquiryOverride : inquiryLine(dialect, stance);

  {
    const lines = a.split("\n");
    const out: string[] = [];
    let placed = false;

    for (const line of lines) {
      const t = line.trimStart();
      if (!t.startsWith("🔎")) {
        out.push(line);
        continue;
      }
      if (placed) continue;
      out.push(desiredInquiry);
      placed = true;
    }

    if (!placed && inquiryOverride) {
      if (out.length > 0 && out[out.length - 1].trim()) out.push("");
      out.push(desiredInquiry);
    }
    a = out.join("\n").trim();
  }

  if (stance === "zubatto") a = forceCasual(a, dialect);

  {
    const lines = a.split("\n");
    const inquiryLines = lines.filter((l) => l.trimStart().startsWith("🔎"));
    if (inquiryLines.length > 0) {
      const rest = lines.filter((l) => !l.trimStart().startsWith("🔎"));
      a = [...rest, inquiryLines[0]].join("\n").trim();
    }
  }

  a = a.replace(/^返事いらんメモ[:：].*$/gm, "").trim();
  return stripInternalLeaks(a);
}

async function generateAnswerStrict(params: {
  message: string;
  promptPartsBase: PromptParts;
  dialect: Dialect;
  stance: Stance;
  usedKnowledge: boolean;
  allowAttackDefenseDetail: boolean;
  inquiryOverride?: string | null;
  llmIntent?: string | null;
}): Promise<string> {
  const { message, promptPartsBase, dialect, stance } = params;

  const forbidden = forbiddenFor(dialect, stance);
  let last = "";
  let lastHits: string[] = [];

  const MAX = 3;
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

    last = postProcessAnswer(result.answer, dialect, stance, {
  usedKnowledge: params.usedKnowledge,
  allowAttackDefenseDetail: params.allowAttackDefenseDetail,
  inquiryOverride: params.inquiryOverride ?? null,
  llmIntent: params.llmIntent ?? null,
});

// 🍚🧂強制：detail許可時に片側欠損なら再生成
if (params.allowAttackDefenseDetail && hasAttackOrDefense(last) && !hasThreePatterns(last)) {
  lastHits = ["🍚/🧂の片側欠損"]; // 禁止語と同じ扱いでリトライに乗せる
  continue;
}

    if (!forbidden) return last;

    lastHits = findForbiddenHits(last, forbidden);
    if (lastHits.length === 0) return last;
  }

  if (stance === "zubatto") return forceCasual(last, dialect);
  return last;
}

/** ===== QA limit (max 6) ===== */
function sortByPriorityDesc(qas: KnowledgeItem[]): KnowledgeItem[] {
  return [...qas].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

function pickTwoBy70and50Preference(qas: KnowledgeItem[]): KnowledgeItem[] {
  const sorted = sortByPriorityDesc(qas);
  if (sorted.length === 0) return [];

  const picked: KnowledgeItem[] = [];
  const used = new Set<string>();

  const pick = (pred: (x: KnowledgeItem) => boolean) => {
    const x = sorted.find((it) => !used.has(it.id) && pred(it));
    if (!x) return null;
    used.add(x.id);
    picked.push(x);
    return x;
  };

  pick((it) => (it.priority ?? 0) >= 70) ?? pick(() => true);
  pick((it) => (it.priority ?? 0) < 70) ?? pick(() => true);

  return picked.slice(0, 2);
}

function pickOtherUpTo2Prefer50(qas: KnowledgeItem[], alreadyPickedIds: Set<string>): KnowledgeItem[] {
  const sorted = sortByPriorityDesc(qas).filter((it) => !alreadyPickedIds.has(it.id));
  if (sorted.length === 0) return [];

  const picked: KnowledgeItem[] = [];
  const used = new Set<string>(alreadyPickedIds);

  const pick = (pred: (x: KnowledgeItem) => boolean) => {
    const x = sorted.find((it) => !used.has(it.id) && pred(it));
    if (!x) return null;
    used.add(x.id);
    picked.push(x);
    return x;
  };

  pick((it) => (it.priority ?? 0) < 70);
  pick((it) => (it.priority ?? 0) < 70);

  while (picked.length < 2) {
    const x = sorted.find((it) => !used.has(it.id));
    if (!x) break;
    used.add(x.id);
    picked.push(x);
  }

  return picked.slice(0, 2);
}

function limitQaMax6(params: {
  itemsForPrompt: KnowledgeItem[];
  subjectTopic: string;
  auditAxis: boolean;
}): { limitedItemsForPrompt: KnowledgeItem[]; pickedQa: KnowledgeItem[]; bucketCounts: { subject: number; audit: number; other: number } } {
  const { itemsForPrompt, subjectTopic, auditAxis } = params;

  const nonQa = (itemsForPrompt ?? []).filter((it) => it.kind !== "qa");
  const qasAll = (itemsForPrompt ?? []).filter((it) => it.kind === "qa");

  const qasSubject = subjectTopic ? qasAll.filter((q) => q.topic === subjectTopic) : [];
  const qasAudit = auditAxis ? qasAll.filter((q) => q.topic === TOPIC_TAX_AUDIT) : [];

  const pickedSubject = pickTwoBy70and50Preference(qasSubject);
  const pickedAudit = pickTwoBy70and50Preference(qasAudit);

  const usedIds = new Set<string>([...pickedSubject, ...pickedAudit].map((x) => x.id));

  const pickedOther = pickOtherUpTo2Prefer50(qasAll, usedIds);

  const pickedQa = [...pickedSubject, ...pickedAudit, ...pickedOther].slice(0, 6);
  const pickedQaIds = new Set(pickedQa.map((x) => x.id));

  const limitedItemsForPrompt = [...nonQa, ...qasAll.filter((q) => pickedQaIds.has(q.id))];

  const cSubject = pickedQa.filter((x) => x.topic === subjectTopic).length;
  const cAudit = pickedQa.filter((x) => x.topic === TOPIC_TAX_AUDIT).length;
  const cOther = pickedQa.length - cSubject - cAudit;

  return { limitedItemsForPrompt, pickedQa, bucketCounts: { subject: cSubject, audit: cAudit, other: cOther } };
}

/** ===== meta builders ===== */
function buildPickedQaMeta(items: KnowledgeItem[], limit = 3): PickedQaMeta[] {
  const rows = (items ?? [])
    .filter((it) => it.kind === "qa")
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .slice(0, Math.max(0, Math.min(10, limit)));
  return rows.map((it) => ({ id: it.id, title: it.title, priority: it.priority, topic: it.topic }));
}
function buildPickedLinesMeta(picked: { attack: KnowledgeLine | null; defense: KnowledgeLine | null }): PickedLineMeta[] {
  const out: PickedLineMeta[] = [];
  if (picked.attack) out.push({ id: picked.attack.id, topic: picked.attack.topic, lens: picked.attack.lens, stance: picked.attack.stance, priority: picked.attack.priority, role: picked.attack.role });
  if (picked.defense) out.push({ id: picked.defense.id, topic: picked.defense.topic, lens: picked.defense.lens, stance: picked.defense.stance, priority: picked.defense.priority, role: picked.defense.role });
  return out.slice(0, 3);
}

/** ===== debug write ===== */
async function writeDebugEvent(params: { db: any; trace: DebugTrace }) {
  const { db, trace } = params;
  try {
    await db.from("chat_debug_events").insert({
      user_id: trace.userId,
      conversation_id: trace.convId || null,
      message_head: trace.messageHead,
      topics_now: trace.topicsNow,
      inferred_topic: trace.inferredTopic,
      lens: trace.lens,
      followup: trace.followup,
      shifted: trace.shifted,
      path: trace.path,
      used_knowledge: trace.usedKnowledge,
      used_lines_pick: trace.usedLinesPick,
      followup_phase: trace.followupPhase,
      followup_explicit: trace.followupExplicit,
      line_request: trace.lineRequest,
      force_normal_answer: trace.forceNormalAnswer,
      meta: trace.meta ?? {},
    });
  } catch (e) {
    console.error("[chat-debug-db-failed]", e);
  }
}
function emitDebug(trace: DebugTrace) {
  console.log(`[chat-trace] ${JSON.stringify(trace)}`);
}

async function fetchPrevDebugLite(
  db: any,
  convId: string
): Promise<{ path: string; lens: string; subjectTopic: string; axisTopic: string } | null> {
  try {
    const { data } = await db
      .from("chat_debug_events")
      .select("path, lens, meta")
      .eq("conversation_id", convId)
      .order("created_at", { ascending: false })
      .limit(1);

    const r = Array.isArray(data) ? data[0] : null;
    if (!r) return null;

    const meta = (r.meta ?? {}) as any;
    return {
      path: String(r.path ?? ""),
      lens: String(r.lens ?? ""),
      subjectTopic: String(meta.subject_topic ?? ""),
      axisTopic: String(meta.axis_topic ?? ""),
    };
  } catch {
    return null;
  }
}

/** ===== footer (tax audit axis) ===== */
function followupFooter(axisTopic: string, dialect: Dialect, stance: Stance): string | null {
  if (axisTopic !== TOPIC_TAX_AUDIT) return null;
  if (dialect === "kansai" && stance === "zubatto") return "※ 税務調査は「形式より実態」「一貫性」を見られる。";
  if (dialect === "kansai" && stance === "sanbo") return "※ 税務調査は「形式より実態」「一貫性」を見られますわ。";
  if (dialect === "standard" && stance === "zubatto") return "※ 税務調査は「形式より実態」「一貫性」を見られる。";
  return "※ 税務調査は「形式より実態」「一貫性」を見られます。";
}

/** ===== POST ===== */
export async function POST(req: Request) {
  // ===== topic / axis / subject (LLM optional) =====
const topicMode: "regex" | "llm" =
  (process.env.TOPIC_MODE || "regex") === "llm" ? "llm" : "regex";

let llmOk = false;
let llmErr = "";
let llmRaw = "";
let llmIntent = "";
let llmConfidence = 0;
let llmReason = "";
let llmTopicsNow: string[] = [];

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
      return NextResponse.json({ ok: false, error: "Plan does not allow chat", used_talks: 0, limit_talks: 0 } satisfies ChatRes, { status: 403 });
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
      // prev user (weak を飛ばして拾う)
      const prevUserMessage = await (async () => {
        const { data: rows } = await db
          .from("messages")
          .select("content")
          .eq("conversation_id", convId)
          .eq("role", "user")
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(10);

        if (!rows || rows.length === 0) return null;
        const current = message.trim();
        const candidates = rows.map((r) => (r.content ?? "").trim()).filter((c) => c && c !== current);
        for (const c of candidates) if (!isWeakUtterance(c)) return c;
        return candidates[0] ?? null;
      })();

      const prevAssistantMessage = await (async () => {
        const { data: prevRows } = await db
          .from("messages")
          .select("content")
          .eq("conversation_id", convId)
          .eq("role", "assistant")
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(1);
        return prevRows?.[0]?.content ?? null;
      })();

      // ===== clarify 判定（前の回答に出てきた用語の追撃）=====
      const clarify = detectClarifyPrevAnswer(message, prevAssistantMessage);
      const clarifyPrevAnswer = clarify.ok;

      // ===== followup 判定（短文誤爆を抑える）=====
      const shiftedRaw = topicShiftLikelyLite(prevUserMessage, message);

      const followupOnlyRaw = isFollowupOnlyText(message);
const followupOnly =
  followupOnlyRaw && !clarifyPrevAnswer && !looksQuestionish(message) && !shiftedRaw; // ★追加

      const weakUtterance = isWeakUtterance(message);

      const followupExplicitRaw = wantsAttackDefenseDetail(message, prevUserMessage);
const followupExplicit = followupExplicitRaw && !clarifyPrevAnswer;

// lineRequest（線引きの明示要求）※LLM intent は後段で合流して最終決定する
const lineRequest = isLineRequest(message);


      const followupPhaseRaw = isInFollowupPhase(prevAssistantMessage);

      const continuationLike =
        followupOnly ||
        lineRequest ||
        followupExplicit ||
        clarifyPrevAnswer ||
        startsWithContinuationPrefix(message) ||
        hasGenericContinuationCue(message) ||
        (weakUtterance && !shiftedRaw);

      const followupPhase = followupPhaseRaw && continuationLike;
      const followup = followupExplicit || followupOnly || lineRequest || (followupPhase && !shiftedRaw);

      // ===== implicit shift（暗黙の話題転換）=====
      const implicitShift =
  !clarifyPrevAnswer && !continuationLike && shiftedRaw && !isShortAckLike(message);


      // ★ 後でクールダウン等で上書きするので let
      let forceNormalAnswer = followupPhase && !followupExplicit && !followupOnly && !lineRequest && !weakUtterance;

      // clarify は必ず normal 回答へ（lines禁止）
      if (clarifyPrevAnswer) forceNormalAnswer = true;

   // topic debug
const topicsNowDbg = inferTopicsDebug(message, { max: 3 });
const topicsNow0 = topicsNowDbg.topics;

const topicsPrevDbg = prevUserMessage ? inferTopicsDebug(prevUserMessage, { max: 3 }) : null;
const topicsPrev = topicsPrevDbg?.topics ?? [];

const recentUserMsgs = await (async () => {
  const { data: rows } = await db
    .from("messages")
    .select("content")
    .eq("conversation_id", convId)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(6);
  return (rows ?? []).map((r) => String(r.content ?? ""));
})();

let decision = decideAxisSubject({
  message,
  topicsNow: [], // ← 空で渡す
  topicsPrev,
  prevAssistantMessage,
  recentUserMsgs,
  continuationLike,
});

// LLM decision（失敗したら従来にフォールバック）
if (topicMode === "llm") {
  const availableTopics = await fetchAvailableTopics(db);
  const llm = await decideTopicByLLM({
    message,
    prevUserMessage: prevUserMessage ?? null,
    prevAssistantMessage: prevAssistantMessage ?? null,
    recentUserMsgs,
    availableTopics,
  });

  llmRaw = llm.rawText ?? "";

  if (llm.ok) {
    llmOk = true;
    llmIntent = llm.decision.intent;
    llmConfidence = llm.decision.confidence;
    llmReason = llm.decision.reason;
    llmTopicsNow = llm.decision.topicsNow ?? [];

    decision = {
      ...decision,
      subjectTopic: llm.decision.subjectTopic,
      axisTopic: llm.decision.axisTopic,
      auditAxis: llm.decision.auditAxis,
      taxAuditSticky: llm.decision.auditAxis,
      reason: `llm:${llm.decision.intent}:${llm.decision.confidence.toFixed(2)}:${llm.decision.reason || ""}`,
    } as any;
  } else {
    llmOk = false;
    llmErr = llm.error;
  }
}

const topicsNow =
  llmOk && topicMode === "llm"
    ? llmTopicsNow.slice(0, 3)
    : []; // ← regex fallback しない

           const prevDebug = await fetchPrevDebugLite(db, convId);

      let subjectTopic = decision.subjectTopic || "";
      let auditAxis = decision.auditAxis;

      // ===== ここから追加：履歴借りの暴走を止める =====
      const bestHit = (topicsNowDbg.hits ?? [])[0] ?? null;
      const nowTop = String(bestHit?.topic ?? (topicsNow0?.[0] ?? "")).trim();
      const nowScore = Number(bestHit?.score ?? 0);

      const prevTop = String(prevDebug?.subjectTopic ?? prevDebug?.axisTopic ?? "").trim();

      // 「現発話のトピックが強い」＝スコア>=10（あなたのtopicSignalsは10が強ヒット）
      const strongNow = Boolean(nowTop) && nowScore >= 10;

      // 直前トピックと違う強トピックが出てるなら、履歴に戻らない
      const blockHistoryBorrow = strongNow && prevTop && nowTop !== prevTop;

      // subject が空なら、強トピックを採用（税務調査は除外）
      if (!subjectTopic && strongNow && nowTop !== TOPIC_TAX_AUDIT) {
        subjectTopic = nowTop;
      }
      // ===== ここまで追加 =====

      // ===== implicit shift 時の税務調査 sticky 吸い込み解除 =====
      const hasAuditWordsNow = hasTaxAuditWordsLite(message);

      const implicitShiftUnstick =
        implicitShift &&
        decision.taxAuditSticky &&
        !hasAuditWordsNow &&
        !lineRequest &&
        !followupExplicit &&
        !followupOnly;

      if (implicitShiftUnstick) {
        auditAxis = false;
      }

      // ===== axisTopic 計算（implicit shift では履歴フォールバックしない）=====
      // 変更：強トピックが出ていて prev と違うなら、履歴フォールバック無効
      const historyAxisRaw = implicitShift ? "" : (inferTopicFromHistory(prevUserMessage, prevAssistantMessage) || "");
      const historyAxis = blockHistoryBorrow ? "" : historyAxisRaw;

      const decisionAxisCandidate = (() => {
        const x = String(decision.axisTopic ?? "").trim();
        if (!x) return "";
        if (x === TOPIC_TAX_AUDIT) return "";
        return x;
      })();

      const axisTopic = auditAxis ? TOPIC_TAX_AUDIT : (subjectTopic || decisionAxisCandidate || historyAxis || "");


     
      const shifted = implicitShift ? true : (decision.taxAuditSticky ? false : shiftedRaw);

      const lensInputUsePrev = (followupOnly || weakUtterance) && Boolean(prevUserMessage);
      const lensRule: Lens = inferLensWithContext({
  message,
  axisTopic,
  fallbackPrevUser: prevUserMessage ?? null,
  usePrevInstead: lensInputUsePrev,
});

const lensLLM = await inferLensByLLM({
  message,
});

// 1) まずは rule と LLM を統合（confidence が弱い時は rule 優先）
const lensMerged: Lens =
  lensLLM.confidence >= 0.6 ? lensLLM.lens : lensRule;

// 2) intent による “候補レンズ” の補正（トピック特例なしの強ルール）
// - need_lines は「金額レンジを出したい」要求として amount を優先候補にする
// - ただし最終決裁は adjustLensByConversation が戻せる（前提不足なら substance/clarify へ）
let lensPre: Lens = lensMerged;

if (llmIntent === "need_lines") {
  lensPre = "amount";
}

// clarify は “結論を出さない” が主眼なので、lens は amount に引っ張られないようにする（保険）
if (llmIntent === "clarify") {
  // ここは system に寄るより substance の方が安全（前提確認に向く）
  lensPre = "substance";
}

// 3) 最終ガード（amount誤爆・system誤誘導など）
const lens: Lens = adjustLensByConversation({
  lens: lensPre,
  message,
  subjectTopic,
  axisTopic,
  llmIntent,
});
      

// ===== followup_lines クールダウン（1回出したら基本リセット）=====
const prevWasLines = prevDebug?.path === "followup_lines";
const prevLens = (prevDebug?.lens ?? "").trim();
const lensChanged = Boolean(prevLens) && prevLens !== lens;

// ===== Lines 出力可否（最終判定）=====
// 方針：🍚🧂（Lines）は「明示要求」or「直前がLinesで継続」のときだけ許可（誤爆ゼロ寄り）

// 「よろ/続き」等の短文承諾だけで Lines を誤爆させない
const suppressLinesByShortAck = isShortAckLike(message) && !lineRequest;

// 継続の「よろ/続き」で Lines を許可する条件（直前が Lines の時だけ）
const allowLinesByContinuation = prevWasLines && isShortAckLike(message);

// regex側のlineRequestと会話状態（継続）をここで合流（LLMのneed_linesはLines許可に使わない）
const lineRequestEffective =
  (lineRequest || allowLinesByContinuation) && !suppressLinesByShortAck;

// LLMモードで subjectTopic が空なら Lines は出さない（ズレ防止）
const linesBlockedNoSubject = topicMode === "llm" && llmOk && lineRequestEffective && !subjectTopic;

// これが“唯一のスイッチ”
const allowLines = lineRequestEffective && !linesBlockedNoSubject;

// Lines を出すときは followup_lines を優先したいので、ここで normal 強制を解除（clarifyは除外）
if (lineRequestEffective && !clarifyPrevAnswer) forceNormalAnswer = false;

const keepLines = lineRequestEffective || lensChanged;

const linesKeepReason = keepLines
  ? lineRequestEffective
    ? (linesBlockedNoSubject ? "keep:line_request_blocked:llm_no_subject" : "keep:line_request")
    : lensChanged
    ? `keep:lens_changed:${prevLens}->${lens}`
    : "keep:other"
  : "cooldown:prev_was_lines";

const linesCooldown = prevWasLines && !keepLines;


if (linesCooldown) {
  forceNormalAnswer = true;
}


      if (linesCooldown) {
        forceNormalAnswer = true;
      }

      // ===== knowledge fetch（主題 + 税務調査 を同時に拾う）=====
      const globalRules = await retrieveGlobalRules({ db });

      let topicKbItems = await retrieveKnowledgeByBuckets({
        db,
        message,
        auditAxis,
        subjectTopic,
        topicsNow: topicsNow0,
        maxTotal: 10,
      });

      const shouldBorrowPrevTopic =
        followup &&
        topicKbItems.length === 0 &&
        topicsNow.length === 0 &&
        Boolean(prevUserMessage) &&
        (weakUtterance || !shifted);

      if (shouldBorrowPrevTopic && prevUserMessage) {
        topicKbItems = await retrieveKnowledgeByBuckets({
          db,
          message: prevUserMessage,
          auditAxis,
          subjectTopic,
          topicsNow: topicsNow0,
          maxTotal: 10,
        });
      }

      const linesPrefaceQa = pickLinesPrefaceQa(topicKbItems);

      const topicKbItemsForPrompt0 = followup
        ? topicKbItems
        : topicKbItems.filter((x) => !(x.kind === "qa" && (x.title ?? "").includes(LINES_PREFACE_TAG)));

      const qaLimited = limitQaMax6({
        itemsForPrompt: topicKbItemsForPrompt0,
        subjectTopic,
        auditAxis,
      });

      const topicKbItemsForPrompt = qaLimited.limitedItemsForPrompt;
      const pickedQaForPrompt = qaLimited.pickedQa;
      const cSubject = qaLimited.bucketCounts.subject;
      const cAudit = qaLimited.bucketCounts.audit;
      const cOther = qaLimited.bucketCounts.other;

      const meta: DebugMeta = {
        picked_qa: buildPickedQaMeta(pickedQaForPrompt, 10),
        picked_lines: [],
        axis_topic: axisTopic,
        subject_topic: subjectTopic,
        audit_axis: auditAxis,

        topic_raw: message,
        topic_raw_json: JSON.stringify(message),
        topic_codepoints_tail: codepointsTail(message, 30),
        topic_normalized: topicsNowDbg.normalized,
        topic_hits: topicsNowDbg.hits,

        prev_debug_path: prevDebug?.path ?? "",
        prev_debug_lens: prevDebug?.lens ?? "",
        lines_cooldown_applied: Boolean(linesCooldown),
        lines_keep_reason: linesKeepReason,
        lines_blocked_no_subject: Boolean(linesBlockedNoSubject),
lines_suppressed_short_ack: Boolean(suppressLinesByShortAck),


        borrowed_prev_topic: shouldBorrowPrevTopic,
        weak_utterance: weakUtterance,
        prev_user_head: dbgHead(prevUserMessage ?? "", 80),
        prev_user_len: (prevUserMessage ?? "").length,

        kb_bucket_counts: { subject: cSubject, audit: cAudit, other: cOther },
        tax_audit_sticky_reason: implicitShiftUnstick ? `implicit_shift_unstick:${decision.reason}` : decision.reason,

        clarify_prev_answer: clarifyPrevAnswer,
        clarify_term: clarify.term || "",
        clarify_matched: clarify.matched || "",
        implicit_shift: Boolean(implicitShift),
        implicit_shift_unstick: Boolean(implicitShiftUnstick),

                topic_mode: topicMode,
        llm_topic_ok: llmOk,
        llm_topic_error: llmErr,
        llm_topic_raw: llmRaw ? clampForContext(llmRaw, 800) : "",
        llm_intent: llmIntent,
        llm_confidence: llmConfidence,
        llm_reason: llmReason,
      };

      meta.lens_rule = lensRule;
meta.lens_llm = lensLLM.lens;
meta.lens_llm_confidence = lensLLM.confidence;
meta.lens_pre = lensPre;
meta.lens_final = lens;


      meta.picked_kb_items = (topicKbItemsForPrompt ?? []).slice(0, 10).map((it) => ({
        id: it.id,
        kind: it.kind,
        topic: it.topic,
        title: it.title,
        priority: it.priority,
      }));

      let usedLinesPick = false;
      let path: DebugTrace["path"] = "normal_llm";

    
      // ===== A) followup_lines =====
if (allowLines && !forceNormalAnswer && lineRequestEffective) {
        const header = stance === "zubatto" ? "判断の軸だけ整理する。" : "判断の軸だけ整理します。";

        const topicForLines = subjectTopic || axisTopic || topicsNow[0] || "";
        if (topicForLines) {
          let built: string | null = null;

          const picked = await retrieveKnowledgeLines({
            db,
            topic: topicForLines,
            lens,
            messageForMatch: message,
          });

          built = buildFollowupAnswerFromLines(picked);
          if (built) {
            usedLinesPick = true;
            path = "followup_lines";
            meta.picked_lines = buildPickedLinesMeta(picked);
          }

          if (!built) {
            const hit = buildFollowupAnswerFromKbWithPick(topicKbItems);
            if (hit) {
              built = hit.text;
              path = "followup_kb";
              meta.picked_qa =
                hit.picked.kind === "qa"
                  ? [{ id: hit.picked.id, title: hit.picked.title, priority: hit.picked.priority, topic: hit.picked.topic }]
                  : meta.picked_qa;
            }
          }

          if (!built) {
  const fb = fallbackAttackDefense(topicForLines, lens);
  built = `🍚攻め：${fb.attack}\n🧂守り：${fb.defense}`.trim();
  meta.built_head = dbgHead(built ?? "", 240);
  path = "followup_fallback";
}


          // built 最終検品：🍚🧂片側欠損は禁止（混線防止）
const builtOk =
  !!built &&
  /🍚\s*攻め\s*[:：]\s*\S/.test(built) &&
  /🧂\s*守り\s*[:：]\s*\S/.test(built);

if (!builtOk) {
  usedLinesPick = false;
  meta.picked_lines = [];
  const fb = fallbackAttackDefense(topicForLines, lens);
  built = `🍚攻め：${fb.attack}\n🧂守り：${fb.defense}`.trim();
  meta.built_head = dbgHead(built ?? "", 240);
  path = "followup_fallback";
}



          const pre = buildLinesPreamble({ topic: topicForLines, axisTopic, dialect, stance, qa: linesPrefaceQa });
          const footer = followupFooter(axisTopic, dialect, stance);

          const inquiryOverride =
            auditAxis && subjectTopic && AUDIT_OVERLAY_TOPICS.has(subjectTopic)
              ? inquiryLineWithAuditCTA(dialect, stance, subjectTopic)
              : inquiryLine(dialect, stance);

          const parts: string[] = [];
          parts.push(header, "", pre.text, "", built);
          if (footer) parts.push("", footer);
          parts.push("", inquiryOverride);

          // ★ここに追加：built が最終確定したら常に記録
meta.built_head = dbgHead(built ?? "", 240);

answer = postProcessAnswer(parts.join("\n").trim(), dialect, stance, {
  usedKnowledge: true,
  allowAttackDefenseDetail: true,
  inquiryOverride,
});

// ===== 最終出力検品：🍚🧂どっちか欠けたら即fallbackで作り直す（最後の砦）=====
const reAttack = /(^|\n)\s*🍚\s*攻め\s*[:：]\s*\S/;
const reDefense = /(^|\n)\s*🧂\s*守り\s*[:：]\s*\S/;
const finalOk = reAttack.test(answer) && reDefense.test(answer);

if (!finalOk) {
  usedLinesPick = false;
  meta.picked_lines = [];

  const fb = fallbackAttackDefense(topicForLines, lens);
  const built2 = `🍚攻め：${fb.attack}\n🧂守り：${fb.defense}`.trim();
  meta.built_head = dbgHead(built2, 240);
  path = "followup_fallback";

  const parts2: string[] = [];
  parts2.push(header, "", pre.text, "", built2);
  if (footer) parts2.push("", footer);
  parts2.push("", inquiryOverride);

  answer = postProcessAnswer(parts2.join("\n").trim(), dialect, stance, {
    usedKnowledge: true,
    allowAttackDefenseDetail: true,
    inquiryOverride,
  });
}
        }
      }

      
      // ===== B) topic未確定だけ clarify =====
      // ※「購入とリースどっち」みたいに具体的な質問は、topicが取れなくても無理に確認を要求しない（弱発話の時だけ）
      const needTopicClarify = !axisTopic && topicsNow.length === 0 && topicKbItems.length === 0 && (followupOnly || weakUtterance);
      const topicClarifyInquiry =
        "🔎確認 どの話の相談かだけ教えて（例：交際費/出張手当/外注/家事按分/福利厚生/役員報酬/車両/消費税/税務調査/退職金/不動産/相続・承継）。";

      const pickedQa = pickBestQaPreferSubject({
        items: topicKbItemsForPrompt,
        message,
        subjectTopic,
        axisTopic,
      });

      const bestQa = pickedQa.qa;
      
      // ===== qa_more: 2枚目QA（priority50側）を使って“続き”を出す =====
const isQaMore = topicMode === "llm" && llmOk && llmIntent === "qa_more";

let bestQaForKeypoint = bestQa;

// qa_more の時だけ、picked_qa の2枚目を優先（あれば）
if (isQaMore) {
  const picked = (pickedQaForPrompt ?? []).filter((x) => x.kind === "qa");
  if (picked.length >= 2) {
    // pickedQaForPrompt は priority降順なので、2枚目を採用
    bestQaForKeypoint = picked[1];
  }
}

const qaKeyPointRule = bestQaForKeypoint ? qaToKeyPointRule(bestQaForKeypoint, 2) : null;

if (qaKeyPointRule && bestQaForKeypoint) {
  meta.qa_keypoint_used_title = bestQaForKeypoint.title;
  meta.qa_keypoint_used = qaKeyPointRule;
  meta.qa_pick_reason = isQaMore ? `${pickedQa.reason}|qa_more:second_qa` : pickedQa.reason;
}

      // ===== C) normal_llm =====
      if (!answer) {
        const usedKnowledge = topicKbItemsForPrompt.length > 0;
       // Lines（🍚🧂）は allowLines（= 明示要求/継続）でのみ許可する。
// LLMの need_lines は「勝手にLinesを許可」しない（誤爆根絶）。
const wantLinesByIntent = false;

const allowAttackDefenseDetail =
  allowLines && lineRequestEffective; // ← “ユーザー明示 or 継続”が前提

const allowAttackDefenseDetailEffective =
  allowAttackDefenseDetail && !linesCooldown && !forceNormalAnswer;

const outputRules = buildOutputRules({ allowAttackDefenseDetail: allowAttackDefenseDetailEffective });


        const kbGlobalBlock = formatKnowledgeBlock(globalRules);
        const kbTopicBlock = formatKnowledgeBlock(topicKbItemsForPrompt);

        
        const ambiguityBoost = buildAmbiguityBoostRules(message);
        const styleRules = buildStyleRules(dialect, stance);
        const contextLines = await buildConversationContext({ db, convId });

        const doubleTopicRule: string[] =
          auditAxis && subjectTopic && subjectTopic !== TOPIC_TAX_AUDIT
            ? [
                `重要：主題は『${subjectTopic}』。ただし回答の軸は『税務調査』。税務調査でどう見られるかを先に1つ言ってから主題に入る。`,
                `重要：『${subjectTopic}』の回答には、⚠️注意で「税務調査での突っ込みポイント」を必ず1つ入れる（例：相手/目的/証拠/現金/領収書/私的混在）。`,
              ]
            : auditAxis
            ? ["重要：回答の軸は税務調査。調査官が何を見るか（実態/一貫性/証拠）を軸に整理する。"]
            : [];

        const systemBias =
          lens === "system"
            ? ["重要：制度（規程/届出/要件）の説明だけで終わらず、最初に『実態の地雷（運用のズレ）』を1つ提示してから制度の話に入る。ネット一般論の羅列は禁止。"]
            : [];

        const amountBias =
          lens === "amount"
            ? [
                allowAttackDefenseDetail
                  ? "重要：金額/レンジの相談。🍚攻め・🧂守りの各行に、条件付きの目安レンジ（例：〜円〜〜円）を必ず入れる。断定しない。"
                  : "重要：金額/レンジの相談。🥄ちょうど良いラインの中で『守り寄りの目安』『攻め寄りの目安』を2行で必ず出す。🍚攻め/🧂守りは初回は出さない。断定しない。",
              ]
            : [];

        const auditIntakeHint =
          axisTopic === TOPIC_TAX_AUDIT && /(最初|初動|電話|連絡|窓口|誰に)/.test(message)
            ? ["重要：顧問税理士がいる前提。税務調査の初動連絡は税理士宛/会社宛どちらもあり得るが、社長が単独で抱えない。「税理士に確認して折り返す」でOK。"]
            : [];


        const clarifyBias =
  topicMode === "llm" && llmOk && llmIntent === "clarify"
    ? [
        "重要：主語が特定できていない。特定トピック（交際費・外注・出張手当など）の一般論・金額例・セーフ/アウト判断を出さない。一般整理は抽象度高く2行まで。",
        "clarify では『〜円まで』など数値の線引きを書かない。書くのは『判断軸』と『どの話かの確認』だけ。",
        "一般整理は2行までにして、最後の🔎確認で「何の話の線引きか」を選択肢で1行だけ促す（例：交際費/外注/出張手当/家事按分/不動産/役員報酬/消費税/税務調査）。",
      ]
    : [];


        const promptPartsBase: PromptParts = {
          context: contextLines,
          injectedRules: [
            ...outputRules,
            ...clarifyBias,
            ...SERVICE_ASSUMPTION_RULES,
            ...doubleTopicRule,
            ...(qaKeyPointRule ? [qaKeyPointRule] : []),
            ...auditIntakeHint,
            ...amountBias,
            ...systemBias,
            ...ambiguityBoost,
            ...styleRules,
            ...(kbGlobalBlock ? [kbGlobalBlock] : []),
            ...(kbTopicBlock ? [kbTopicBlock] : []),
          ],
          guardrails: gr.action === "inject" ? gr.guardrailLines : [],
        };


        const inquiryOverride =
          needTopicClarify
            ? topicClarifyInquiry
            : auditAxis && subjectTopic && AUDIT_OVERLAY_TOPICS.has(subjectTopic)
            ? inquiryLineWithAuditCTA(dialect, stance, subjectTopic)
            : null;

        answer = await generateAnswerStrict({
  message,
  promptPartsBase,
  dialect,
  stance,
  usedKnowledge,
  allowAttackDefenseDetail: allowAttackDefenseDetailEffective,
  inquiryOverride,
  llmIntent: (topicMode === "llm" && llmOk ? llmIntent : null),
});

        path = "normal_llm";
      }

      answer = stripInternalLeaks(answer);



// ===== implicit shift で sticky を外した場合：税務調査エッセンスを固定1行だけ添える =====
const prevAxisTopic = (prevDebug?.axisTopic ?? "").trim();
if (implicitShiftUnstick && prevAxisTopic === TOPIC_TAX_AUDIT) {
  answer = insertLineBeforeInquiry(answer, auditEssenceOneLine(dialect, stance));
  meta.audit_essence_injected = true;
}

// ===== answer sanity (server side) =====
const reAttack = /(^|\n)\s*🍚\s*攻め\s*[:：]\s*\S/;
const reDefense = /(^|\n)\s*🧂\s*守り\s*[:：]\s*\S/;

meta.answer_has_rice = answer.includes("🍚");   // ←これは「絵文字がどっかに居る」判定として残すならOK
meta.answer_has_salt = answer.includes("🧂");

meta.answer_has_attack_plain = reAttack.test(answer);   // ← “plain” ちゃうけど互換優先ならここに上書き
meta.answer_has_defense_plain = reDefense.test(answer);

meta.answer_head = dbgHead(answer, 200);


      const trace: DebugTrace = {
        convId,
        userId: user.id,
        messageHead: dbgHead(message, 120),
        topicsNow,
        inferredTopic: axisTopic || "",
        lens,
        followupExplicit,
        followupPhase,
        lineRequest: lineRequestEffective,
        shifted,
        followup,
        forceNormalAnswer,
        usedKnowledge: topicKbItemsForPrompt.length > 0,
        usedLinesPick,
        path,
        meta,
      };

      emitDebug(trace);
      await writeDebugEvent({ db, trace });
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
      return NextResponse.json({ ok: false, error: "Monthly quota exceeded", used_talks: usage.used_talks, limit_talks: usage.limit_talks } satisfies ChatRes, { status: 429 });
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
