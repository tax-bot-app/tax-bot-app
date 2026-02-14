// app/api/chat/route.ts
import { generateAnswer } from "../../lib2/ai/generateAnswer";
import { decideAnchorQaByLLM } from "../../lib2/ai/decideAnchorQaByLLM";
import type { PromptParts } from "../../lib2/ai/prompt";
import { judgeGuardrails } from "../../lib2/guardrails";
import { decideSuppressBrandingByLLM } from "../../lib2/guardrails/brandSuppressByLLM";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// NEW: split
import {
  inferTopicsDebug,
  inferTopicFromHistory,
  isWeakUtterance,
  isFollowupOnlyText,
} from "../../lib2/topicSignals";
import {
  decideAxisSubject,
  inferLensWithContext,
  TOPIC_TAX_AUDIT,
  AUDIT_OVERLAY_TOPICS,
  type Lens,
} from "../../lib2/topicDecision";

// LLM topic decision
import { decideTopicByLLM } from "../../lib2/ai/topicDecisionLlm";
import { inferLensByLLM } from "../../lib2/ai/inferLensByLLM";
import { chooseQaByLLM } from "../../lib2/ai/chooseQaByLLM";


export const runtime = "nodejs";

/** ===== constants ===== */
const LINES_PREFACE_TAG = "【Lines前置き】";

const SERVICE_BASE_RULES: string[] = [
  "重要：このサービスは『顧問税理士がいる前提』で答える。顧問税理士がいない前提の案内（例：税理士の有無確認・選任の勧め・無い場合の段取り）は原則書かない。",
  "例外：ユーザーが明示的に『顧問税理士がいない』と言った場合だけ、その前提で答える。",
];

const TAX_AUDIT_ROLE_SPLIT_RULE =
"税務調査の話の時だけ、社長がやること/税理士がやることを分けて書く（それ以外は分けない）。";

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
function clampForContext(s: string, n: number) {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n) + "…";
}
function dbgHead(s: string, n = 80) {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n) + "…";
}
function codepointsTail(s: string, n = 24): string {
  const arr = Array.from(String(s ?? ""));
  const tail = arr.slice(Math.max(0, arr.length - n));
  return tail
    .map((ch) => {
      const cp = ch.codePointAt(0);
      const hex =
        cp === undefined
          ? "??"
          : "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
      const visible =
        ch === " " ? "␠" : ch === "\n" ? "␤" : ch === "\t" ? "␉" : ch;
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
// ★追加（任意）
guardrail_block?: boolean;
guardrail_action?: "block" | "inject" | "none";
    }
  | {
      ok: false;
      error: string;
      used_talks?: number | null;
      limit_talks?: number | null;
      conversation_id?: string | null;

      // ★追加（任意）
      guardrail_block?: boolean;
      guardrail_action?: "block" | "inject" | "none";
    };


type Dialect = "kansai" | "standard";
type Stance = "zubatto" | "sanbo";
type MsgMini = {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

type StanceAD = "attack" | "defense";
type RoleKL = "user" | "internal";

type KnowledgeLine = {
  id: string;
  topic: string;
  stance: StanceAD;
  lens: Lens;
  role?: RoleKL | null;
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
type PickedLineMeta = {
  id: string;
  topic: string;
  lens: Lens;
  stance: StanceAD;
  priority: number;
  role?: RoleKL | null;
};

type DebugMeta = {
  // ===== 入力/前後関係 =====
  topic_raw?: string;
  topic_raw_json?: string;
  topic_codepoints_tail?: string;
  topic_normalized?: string;
  topic_hits?: any;

  prev_user_head?: string;
  prev_user_len?: number;
  prev_debug_path?: string;
  prev_debug_lens?: string;

  weak_utterance?: boolean;
  clarify_prev_answer?: boolean;
  clarify_term?: string;
  clarify_matched?: string;

  // ===== topic decision =====
  topic_mode?: "regex" | "llm";
  llm_topic_ok?: boolean;
  llm_topic_error?: string;
  llm_topic_raw?: string;
  llm_intent?: string;
  llm_confidence?: number;
  llm_reason?: string;
  llm_shift_cue?: boolean;
  llm_shift_cue_reason?: string;



  subject_topic?: string;
  axis_topic?: string;
  audit_axis?: boolean;
  prefer_rule_lens?: boolean;

  borrowed_prev_topic?: boolean;
  implicit_shift?: boolean;
  implicit_shift_unstick?: boolean;
  tax_audit_sticky_reason?: string;


  // ===== lens decision =====
  lens_message_head?: string;
  lens_rule?: Lens;
  lens_llm?: Lens;
  lens_llm_confidence?: number;
  lens_pre?: Lens;
  lens_final?: Lens;
  

  // ===== lines gating / pick =====
  line_request_effective?: boolean;
  allow_lines?: boolean;

  lines_keep_reason?: string;
  lines_cooldown_applied?: boolean;
  lines_blocked_no_subject?: boolean;
  lines_suppressed_short_ack?: boolean;

  topic_for_lines?: string;
  lens_for_lines?: Lens;
  lines_pick_attempted?: boolean;
  lines_pick_success?: boolean;
  lines_pick_lens_used?: Lens | null;

  picked_lines?: PickedLineMeta[];

  // ===== knowledge/qa =====
  kb_bucket_counts?: { subject: number; audit: number; other: number };
  picked_kb_items?: Array<{
    id: string;
    kind: "rule" | "qa" | "example";
    topic: string;
    title: string;
    priority: number;
  }>;

  picked_qa?: PickedQaMeta[];
  qa_keypoint_used_title?: string;
  qa_keypoint_used?: string;
  qa_pick_reason?: string;

    // ===== QA cross (LLM召集) =====
  qa_cross_pool_n?: number;
  qa_cross_llm_ok?: boolean;
  qa_cross_llm_error?: string;
  qa_cross_llm_raw?: string;
  qa_cross_selected_ids?: string[];
  qa_cross_selected_reasons?: Record<string, string>;
  qa_cross_candidates_50?: Array<{ id: string; title: string; topic: string; priority: number; score: number }>;

  // ===== QA hybrid pick =====
  qa_hybrid_candidate_n?: number;
  qa_hybrid_candidates_50?: Array<{
    id: string;
    title: string;
    topic: string;
    priority: number;
    bucket: "subject" | "audit" | "other";
    score: number;
  }>;
  qa_hybrid_llm_ok?: boolean;
  qa_hybrid_llm_error?: string;
  qa_hybrid_llm_raw?: string;
  qa_hybrid_selected_ids?: string[];
  qa_hybrid_selected_reasons?: Record<string, string>;

  // ===== QA anchor（picked_qa内でドンピシャ判定）=====
  qa_anchor_llm_ok?: boolean;
  qa_anchor_llm_error?: string;
  qa_anchor_llm_raw?: string;
  qa_anchor_id?: string;
  qa_anchor_confidence?: number;
  qa_anchor_reason?: string;
  qa_anchor_applied?: boolean;

  // ===== output/debug =====
  used_sajikagen?: boolean;
  audit_essence_injected?: boolean;

  built_head?: string;

  answer_has_rice?: boolean;
  answer_has_salt?: boolean;
  answer_has_attack_plain?: boolean;
  answer_has_defense_plain?: boolean;
  answer_head?: string;
  answer_full?: string;

  nudge_lines_llm?: boolean;
  nudge_lines_reason?: string;
  nudge_lines_applied?: boolean;

    // ===== guardrails / branding suppress =====
  guardrail_action?: "block" | "inject" | "none";
  guardrail_reason?: string;

  suppress_branding?: boolean;
  suppress_branding_reason?: string;

  // （任意だが便利）レスポンス整合のため残す
  dialect?: Dialect;
  stance?: Stance;

};

type DebugTrace = {
  convId: string;
  userId: string;
  messageHead: string;
  topicsNow: string[];
  inferredTopic: string;
  lens: Lens;
  followupExplicit: boolean;
  followupPhase: boolean;
  lineRequest: boolean;
  shifted: boolean;
  followup: boolean;
  forceNormalAnswer: boolean;
  usedKnowledge: boolean;
  usedLinesPick: boolean;
    path: "followup_lines" | "normal_llm" | "guardrail:block";
  meta?: DebugMeta;
};

/** ===== normalize ===== */
function normalizeDialect(x: string): Dialect {
  return x === "standard" ? "standard" : "kansai";
}
function normalizeStance(x: Stance): Stance {
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
  if (
    /^(よろ|よろしく|よろしこ|よろ！|よろー|よろです！|頼む|たのむ|お願い|おねがい|おねげぇ|つづき|続き)$/.test(
      m
    )
  )
    return true;
  if (m.length <= 6 && /^[ぁ-んー！!？?]+$/.test(m)) return true;
  return false;
}

function startsWithContinuationPrefix(message: string): boolean {
  const m = (message ?? "").trim();
  return /^(それ|その|じゃあ|じゃ|ほな|で|なら|今の|さっき|続き|つづき|あと|それで)/.test(
    m
  );
}
function hasGenericContinuationCue(message: string): boolean {
  const m = (message ?? "").trim();
  return /(どうすれば|どうしたら|どう対応|何したら|何から|結局|つまり|次(は)?|このあと|具体的に|要は)/.test(
    m
  );
}
function looksQuestionish(message: string): boolean {
  const m = (message ?? "").trim();
  if (!m) return false;
  if (/[?？]/.test(m)) return true;
  return /(何|なに|どう|どっち|どちら|いつ|どこ|だれ|誰|なぜ|なんで|意味|どゆ|どういう|って|とは)/.test(
    m
  );
}
function tokens3(s: string): string[] {
  return Array.from((s ?? "").matchAll(/[一-龠ぁ-んァ-ンA-Za-z0-9]{3,}/g)).map(
    (m) => m[0]
  );
}
function extractClarifyTerm(message: string): string | null {
  const raw = (message ?? "").trim();
  if (!raw) return null;
  const s = raw
    .replace(/[！!。．…]+$/g, "")
    .replace(/[?？]+$/g, "")
    .trim();
  if (!s) return null;

  const m1 = s.match(
    /^(.+?)(?:って|て|とは)\s*(?:何|なに|どういう意味|どういうこと|どゆこと|どゆ意味|意味)$/
  );
  if (m1?.[1]) return m1[1].trim();
  const m2 = s.match(/^(.+?)(?:って|て|とは)\s*$/);
  if (m2?.[1]) return m2[1].trim();

  const solo = s.trim();
  if (solo.length <= 10 && !/\s/.test(solo)) return solo;
  return null;
}
function normKey(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[\/\\・\.\-＿_]/g, "");
}
function detectClarifyPrevAnswer(
  message: string,
  prevAssistantMessage: string | null
): { ok: boolean; term: string; matched: string } {
  const prev = (prevAssistantMessage ?? "").trim();
  if (!prev) return { ok: false, term: "", matched: "" };

  const term = (extractClarifyTerm(message) ?? "").trim();
  if (!term) return { ok: false, term: "", matched: "" };

  if (term.length >= 2 && prev.includes(term)) return { ok: true, term, matched: term };

  const prevK = normKey(prev);
  const termK = normKey(term);
  if (termK.length >= 2 && prevK.includes(termK))
    return { ok: true, term, matched: term };

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
  if (idx < 0)
    return `${a0}\n\n${l}`.replace(/\n{3,}/g, "\n\n").trim();
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
  if (dialect === "kansai" && stance === "sanbo")
    return "※ 税務調査目線：形式より実態。一貫性と証拠で見られますわ。";
  if (dialect === "standard" && stance === "sanbo")
    return "※ 税務調査目線：形式より実態。一貫性と証拠で見られます。";
  return "※ 税務調査目線：形式より実態。一貫性と証拠で見られる。";
}

/** ===== output rules ===== */
function buildOutputRules(params: { allowAttackDefenseDetail: boolean }): string[] {
  const { allowAttackDefenseDetail } = params;

  const detailRule = allowAttackDefenseDetail
    ? "ユーザーが深掘りを求めた場合は、**必ず** 見出し付きで『🍚攻め』『🧂守り』の詳細ブロックを出す。『🥄ちょうど良いライン』や要点の繰り返しは禁止。"
    : "初回回答では『🍚攻め』『🧂守り』は出さない。判断軸として『🥄ちょうど良いライン』と要点の説明だけに限定する。";

  return [
    "Markdownの見出し（##、###など）は使わない。",
    "見出しラベルは固定：『🥄ちょうど良いライン』『✅要点』『⚠️注意』。", // ← 🔎確認を削除
    "初回は『🥄ちょうど良いライン』→『✅要点』の順で書く。",
    detailRule,
    "『🍚攻め』『🧂守り』を出した場合は決めゼリフは禁止。",
    "決めゼリフはサーバ側で付与する。",
    "回答末尾に『🔎確認』の固定文を付けない。必要ならサーバ側で短い締め文を付与する。", // ←ここに置換
  ];
}


function buildAmbiguityBoostRules(message: string): string[] {
  const m = (message ?? "").trim();
  const hasTaxWords =
    /税|経費|損金|消費税|源泉|役員|給与|交際費|棚卸|売上|請求|領収|仕訳|法人|個人|青色|調査|否認|事業|私用|按分/.test(
      m
    );
  if (!m) return [];
  const hasSafety = /安全度|安全性|リスク|危険|グレー|大丈夫/.test(m);
  if (!hasSafety) return [];

  return [
    "重要：ユーザーの『安全度/安全性/大丈夫？/リスク』は、まず税務・経営の安全性として解釈する（否認リスク/税務調査リスク/資金繰り・意思決定リスク）。一般的な安全（健康/事故/防犯）に逸れない。",
    "『安全度』は必ず『税務上の安全度（否認リスク/税務調査リスク）』として 高/中/低 の3段階で返す。",
  ];
}

/** ===== style ===== */
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
function forbiddenFor(_dialect: Dialect, stance: Stance): string[] | null {
  if (stance === "zubatto") return FORBIDDEN_POLITE;
  return null;
}
function findForbiddenHits(text: string, forbidden: string[]): string[] {
  const hits: string[] = [];
  for (const w of forbidden) if (text.includes(w)) hits.push(w);
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
      rules.push(
        "標準語の敬語（〜です/〜ますの“標準語文体”）は禁止。丁寧語を使う場合も関西の言い回しで統一する。"
      );
      rules.push(
        "文末の7割以上を丁寧語で終える。『や・で』で終えるのは禁止に近い（例外はツッコミ1回まで）。"
      );
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
  if (/(攻め\s*\/\s*守り|攻め\s*守り|攻めと守り|攻め守りで)/.test(m)) return true;
  if (/(攻めのライン|守りのライン)/.test(m)) return true;
  if (/さじかげん/.test(m)) return true;
  return false;
}
function isLineDetailRequest(message: string): boolean {
  const m = (message ?? "").trim();
  return /(攻め|守り|攻守|上限|限界|安全ライン|レンジ|幅|いくら|なんぼ|金額|いくつまで|どんぐらい)/.test(
    m
  );
}

// ★ 金額っぽさ：数字+円/万 なども拾う（「1万超える」系を落とさない）
function hasMoneyLike(message: string): boolean {
  const m = (message ?? "").trim();
  if (!m) return false;
  // 半角/全角数字 + 通貨単位
  if (/(?:[0-9０-９][0-9０-９,，\.]*\s*(?:円|万円|万|千円|千|百万円|億円|億))/u.test(m))
    return true;
  // 雑に漢数字も拾う（例：一万円/十万など）
  if (/(?:一|二|三|四|五|六|七|八|九|十|百|千|万|億){1,8}\s*(?:円|万円|万|千円|億円|億)/u.test(m))
    return true;
  return false;
}

function isAmountAsk(message: string): boolean {
  const m = (message ?? "").trim();
  if (!m) return false;
  if (hasMoneyLike(m)) return true;
  return /(いくら|なんぼ|金額|上限|限界|レンジ|幅|いくつまで|どこまで|ギリ|安全|セーフ|アウト|グレー)/.test(
    m
  );
}

function adjustLensByConversation(params: {
  lens: Lens;
  lensMessage: string;
  subjectTopic: string;
  axisTopic: string;
  llmIntent: string;
}): Lens {
  const { lens, lensMessage, subjectTopic, axisTopic, llmIntent } = params;
  const m = (lensMessage ?? "").trim();
  const topic = (subjectTopic || axisTopic || "").trim();

  if (llmIntent === "clarify" || llmIntent === "qa_more") {
    if (lens === "amount") return "substance";
  }

  // amount → substance の落とし穴：短い合言葉 followup で誤爆しやすいので、
  // 「金額っぽさ（数字+円/万）」も見て amount を維持する
  if (lens === "amount" && !isAmountAsk(m)) return "substance";

  if (
    topic === "外注" &&
    /(毎月|月々|同じ金額|定額|固定)/.test(m) &&
    !isAmountAsk(m)
  )
    return "substance";

  if (/(インボイス|登録|未登録|適格|源泉|支払調書|請求書|契約書|規程|届出|要件)/.test(m))
    return "system";

  return lens;
}

function topicShiftLikelyLite(prevUser: string | null, cur: string): boolean {
  const prev = (prevUser ?? "").trim();
  const now = (cur ?? "").trim();
  if (!prev || !now) return false;

  const tokens = (s: string) =>
    Array.from(s.matchAll(/[一-龠ぁ-んァ-ンA-Za-z0-9]{3,}/g)).map(
      (x) => x[0]
    );
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

  const strong =
    /攻め|守り|攻守|上限|限界|どこまで|ギリ|グレー|危険|安全ライン|幅|レンジ|強め|弱め|リスク高|リスク低/.test(
      m
    );
  if (strong) return true;

  const followupCue =
    /(教えて|おしえて|詳しく|詳細|具体|もう少し|もっと|続き|つづき|お願い|おねがい|頼む|たのむ|よろしく|再度|もう一回|もういちど|さっき|よろしこ)/.test(
      m
    );
  const veryShort = m.length <= 2 || /^[\.\-ー…\?？!！wｗ]+$/.test(m);

  const topicShiftLikely = (() => {
    if (!prev) return false;
    const tokens = (s: string) =>
      Array.from(s.matchAll(/[一-龠ぁ-んァ-ンA-Za-z0-9]{3,}/g)).map(
        (x) => x[0]
      );
    const a = tokens(prev);
    const b = tokens(m);
    if (a.length === 0 || b.length === 0) return false;
    const setA = new Set(a);
    const overlap = b.some((t) => setA.has(t));
    return !overlap;
  })();

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
    const { data } = await db
      .from("knowledge_items")
      .select("topic")
      .eq("is_active", true)
      .limit(500);
    for (const r of (data ?? []) as any[]) {
      const t = String(r?.topic ?? "").trim();
      if (t) out.add(t);
    }
  } catch {}

  try {
    const { data } = await db
      .from("knowledge_lines")
      .select("topic")
      .eq("is_active", true)
      .limit(500);
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
  return Array.from((s ?? "").matchAll(/[一-龠ぁ-んァ-ンA-Za-z0-9]{3,}/g)).map(
    (m) => m[0]
  );
}

async function fetchAllQaByTopic(params: {
  db: any;
  topic: string;
}): Promise<KnowledgeItem[]> {
  const { db, topic } = params;
  if (!topic) return [];

  const { data, error } = await db
    .from("knowledge_items")
    .select("id, kind, topic, title, content, amounts, conditions, priority")
    .eq("is_active", true)
    .eq("kind", "qa")
    .eq("topic", topic)
    .order("priority", { ascending: false })
    .order("id", { ascending: true }); // 安定化

  if (error) return [];
  return (data ?? []) as KnowledgeItem[];
}


async function retrieveKnowledgeByBuckets(params: {
  db: any;
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

  // buckets
  const subjectItems = wantsBuckets ? await fetchTopic(subjectTopic, quotaSubject) : [];
  const auditItems = wantsBuckets ? await fetchTopic(TOPIC_TAX_AUDIT, quotaAudit) : [];
  const otherTopics = (topicsNow ?? []).filter((t) => t && t !== TOPIC_TAX_AUDIT);
  const topicsForNonBucket = Array.from(new Set([subjectTopic, ...otherTopics].filter(Boolean)));
  const otherItems = await fetchTopics(wantsBuckets ? otherTopics : topicsForNonBucket, quotaOther);

  let merged = uniqById([...subjectItems, ...auditItems, ...otherItems]).slice(0, maxTotal);

  if (merged.length < maxTotal && wantsBuckets) {
    const poolTopics = Array.from(
      new Set([subjectTopic, ...(auditAxis ? [TOPIC_TAX_AUDIT] : []), ...otherTopics].filter(Boolean))
    );
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
}): Promise<{
  attack: KnowledgeLine | null;
  defense: KnowledgeLine | null;
  lensUsed: Lens | null;
}> {
  const { db, topic, lens, messageForMatch } = params;

  const run = async (selectRole: boolean, lensArg: Lens) => {
    const sel = selectRole
      ? "id, topic, stance, lens, role, text, priority"
      : "id, topic, stance, lens, text, priority";
    return db
      .from("knowledge_lines")
      .select(sel)
      .eq("is_active", true)
      .eq("topic", topic)
      .eq("lens", lensArg)
      .in("stance", ["attack", "defense"])
      .order("priority", { ascending: false })
      .limit(30);
  };

  const tryFetch = async (lensArg: Lens) => {
    let data: any[] | null = null;
    let error: any = null;

    // role列があるなら取りたい（ただし SQL で role=user 固定はしない。空/NULL/未投入で全滅しやすい）
    const r1 = await run(true, lensArg);
    data = r1?.data ?? null;
    error = r1?.error ?? null;

    const msg = String(error?.message ?? "");
    const missingRole = /role/i.test(msg) && /(column|does not exist|unknown)/i.test(msg);

    if (error && missingRole) {
      const r2 = await run(false, lensArg);
      data = r2?.data ?? null;
      error = r2?.error ?? null;
    }

    if (error || !data) return [] as KnowledgeLine[];

    const rows = (data ?? []) as KnowledgeLine[];

    // role があれば：
    //  - user が1つでもあれば user を優先
    //  - なければ internal を落として残り（null/undefined含む）を使う
    const userRows = rows.filter((r) => (r as any)?.role === "user");
    if (userRows.length > 0) return userRows;
    return rows.filter((r) => (r as any)?.role !== "internal");
  };

  const lensFallbacks: Lens[] =
    topic === TOPIC_TAX_AUDIT ? ["substance", "system", "amount"] : [lens, "substance", "system", "amount"];

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
      const minLen = 8;
      const base = rows
        .filter((r) => r.stance === stance)
        .filter((r) => !isLeakyLine(r.text))
        .filter((r) => String(r.text ?? "").trim().length >= minLen);

      if (base.length === 0) return null;

      const scored = base.map((r) => ({ r, s: scoreText(r.text) }));
      scored.sort((a, b) => b.s - a.s || (b.r.priority ?? 0) - (a.r.priority ?? 0));
      return scored[0]?.r ?? null;
    };

    const attack = pickOne("attack");
    const defense = pickOne("defense");
    if (attack && defense) return { attack, defense, lensUsed: lf };
  }

  return { attack: null, defense: null, lensUsed: null };
}

function pickBestQaForMessage(items: KnowledgeItem[], message: string): KnowledgeItem | null {
  const m = (message ?? "").trim();
  const qas = (items ?? []).filter((x) => x.kind === "qa");
  if (qas.length === 0) return null;

  const intakeHit = /(最初|初動|電話|連絡|窓口|誰に)/.test(m);
  if (intakeHit) {
    const hit = qas.find((q) =>
      /(最初|連絡|電話|窓口|誰に)/.test((q.title ?? "") + " " + (q.content ?? ""))
    );
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

function formatKnowledgeBlock(items: KnowledgeItem[]): string {
  if (!items || items.length === 0) return "";
  const lines: string[] = [];
  lines.push("【育成知見（最優先）】");
  lines.push("※一般論より優先して扱う。金額の目安は育成知見を採用する。");
  for (const it of items) {
    const tag = it.kind === "rule" ? "[Rule]" : it.kind === "qa" ? "[Q&A]" : "[Example]";
    lines.push(`${tag} ${it.title}`);
    lines.push(`- ${it.content.replace(/\r\n/g, "\n").split("\n").join("\n- ")}`);
    if (it.amounts && Object.keys(it.amounts).length > 0)
      lines.push(`- 目安金額: ${JSON.stringify(it.amounts)}`);
  }
  return lines.join("\n");
}

/** ===== followup (Lines only) ===== */
function buildFollowupAnswerFromLines(params: {
  attack: KnowledgeLine | null;
  defense: KnowledgeLine | null;
}): string | null {
  const at = (params.attack?.text ?? "").trim();
  const df = (params.defense?.text ?? "").trim();
  if (!at || !df) return null;
  return `🍚攻め：${at}\n🧂守り：${df}`.trim();
}

function pickLinesPrefaceQa(items: KnowledgeItem[]): KnowledgeItem | null {
  const qas = (items ?? []).filter(
    (x) => x.kind === "qa" && (x.title ?? "").includes(LINES_PREFACE_TAG)
  );
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

  // 🍚🧂の本文に「とはいえ」が混ざるのは普通に起こる。
  // Linesの行まで消すと片側欠損になるので除外する。
  if (t.startsWith("🍚") || t.startsWith("🧂")) return false;
  if (t.includes("🍚攻め") || t.includes("🧂守り")) return false;

  // 決めゼリフ“単独行”だけを除去する（本文内の語は残す）
  if (/^とはいえ[、,\s]/.test(t)) return true;
  if (/税務の世界.*答え/.test(t) && !/[。！？]/.test(t.replace(/税務の世界.*答え/, ""))) return true;

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
    out[i] = out[i].replace(
      /^(\s*)(.*?)(\s*)$/,
      (_m, p1, body, p2) => `${p1}**${String(body).trim()}**${p2}`
    );
    break;
  }
  return out;
}


function enforceTemplate(answer: string): string {
  const a = answer.replace(/\r\n/g, "\n").trim();
  if (!a) return a;

  if (hasAttackOrDefense(a) && !hasThreePatterns(a)) return a;
  if (hasThreePatterns(a)) return a;

  const secLine = ensureLineBold(extractSection(a, "🥄"));
  const key = extractSection(a, "✅");
  const warn = extractSection(a, "⚠️");
  if (secLine.length === 0 || key.length === 0) return a;

  const parts: string[] = [];
  parts.push(...secLine, "");
  parts.push(...key);
  if (warn.length > 0) parts.push("", ...warn);
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


function stripInternalLeaks(text: string): string {
  let s = String(text ?? "").replace(/\r\n/g, "\n");
  s = s.replace(/[\(（][^()（）]*(未登録|ここに|DB|データベース|育成|internal|TODO)[^()（）]*[\)）]/gi, "");
  const ng = [
    /未登録/gi,
    /ここに/gi,
    /\bDB\b/gi,
    /データベース/gi,
    /育成知見/gi,
    /\binternal\b/gi,
    /\bTODO\b/gi,
    /開発用/gi,
  ];
  const lines = s.split("\n");
  const out = lines.filter((line) => !ng.some((re) => re.test(line)));
  s = out.join("\n").trim();
  if (!s)
    s = "🥄ちょうど良いライン：**一般論で整理する**。必要なら条件を揃えて深掘りする。";
  return s;
}

// （〆）以降の最大3行を取り出し、本文から除去する
function splitWarmClose(answer: string): { body: string; close: string } {
  const lines = String(answer ?? "").replace(/\r\n/g, "\n").split("\n");
  const idx = lines.findIndex((l) => l.trimStart().startsWith("（〆）"));
  if (idx < 0) return { body: String(answer ?? "").trim(), close: "" };

  const body = lines.slice(0, idx).join("\n").trim();
  const closeLines = lines
    .slice(idx, idx + 3)
    .map((l) => l.replace(/^（〆）\s*/, "").trim())
    .filter(Boolean);

  return { body, close: closeLines.join("\n").trim() };
}

function postProcessAnswer(
  raw: string,
  dialect: Dialect,
  stance: Stance,
  opts: {
    usedKnowledge: boolean;
    allowAttackDefenseDetail: boolean;
    inquiryOverride?: string | null;
    llmIntent?: string | null;
    subjectTopic?: string | null;
    topicsNow?: string[] | null;

    // ★追加
    suppressBranding?: boolean;
  }
): string {
  const llmIntent = safeStr(opts.llmIntent ?? "").trim();
  const usedKnowledge = opts.usedKnowledge;
  const allowAttackDefenseDetail = opts.allowAttackDefenseDetail;
  const inquiryOverride = (opts.inquiryOverride ?? "").trim();

  const suppressBranding = !!opts.suppressBranding;

  let a = String(raw ?? "").replace(/\r\n/g, "\n").trim();
  a = a.replace(/[\(（]最大[^)）]*[\)）]/g, "");

  if (hasThreePatterns(a)) {
    const lines = a.split("\n");
    const out = lines.filter((line) => !isCatchphraseLine(line));
    a = out.join("\n").trim();
  }

  a = enforceTemplate(a);

  // allowAttackDefenseDetail=false の時は 🍚🧂を強制で落とす（偽Lines根絶）
  if (!allowAttackDefenseDetail) {
    a = a
      .split("\n")
      .filter((line) => {
        const t = line.trimStart();
        if (t.startsWith("🍚攻め") || t.startsWith("🧂守り")) return false;
        if (/^(攻め|守り)\s*[:：]/.test(t)) return false;
        return true;
      })
      .join("\n")
      .trim();
  } else {
    // followup_lines は 🥄 を削る（重複を避ける）
    a = a
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("🥄"))
      .join("\n")
      .trim();
  }

  // ★追加：抑制時は 🥄 / 👉 / 🔎 を“先に”落とす（後工程で復活しないように）
  if (suppressBranding) {
    a = a
      .split("\n")
      .filter((line) => {
        const t = line.trimStart();
        if (t.startsWith("🥄")) return false;
        if (t.startsWith("👉")) return false;
        if (t.startsWith("🔎")) return false;
        return true;
      })
      .join("\n")
      .trim();
  }

  const alreadyCatch = a.split("\n").some((line) => isCatchphraseLine(line));
  const isQaFirst = llmIntent === "qa_first";

  // topicsNow は配列 or 文字列のどちらでも来る可能性があるので正規化
  const topicsNowRaw = opts?.topicsNow ?? [];
  const topicsNow0 = Array.isArray(topicsNowRaw)
    ? topicsNowRaw
    : String(topicsNowRaw)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

  const isPrivateMix =
    (opts?.subjectTopic ?? "") === "私的混在・実態論点" ||
    topicsNow0.includes("私的混在・実態論点");

  // CTA抑制（既存：私的混在）
  const suppressCta = isPrivateMix || suppressBranding;

  if (stance === "zubatto") a = forceCasual(a, dialect);

   // 🔎は廃止：来ても落とす
  a = a
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("🔎"))
    .join("\n")
    .trim();

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
  subjectTopic?: string | null;
  topicsNow?: string[] | null;
  inquiryOverride?: string | null;
  llmIntent?: string | null;
  suppressBranding?: boolean; // ★追加
}): Promise<string> {
  const { promptPartsBase, dialect, stance } = params;
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

    const result = await generateAnswer({ message: params.message, promptParts });

    last = postProcessAnswer(result.answer, dialect, stance, {
      usedKnowledge: params.usedKnowledge,
      allowAttackDefenseDetail: params.allowAttackDefenseDetail,
      inquiryOverride: params.inquiryOverride ?? null,
      llmIntent: params.llmIntent ?? null,
      subjectTopic: params.subjectTopic ?? null,
      topicsNow: params.topicsNow ?? null,
      suppressBranding: Boolean(params.suppressBranding),
    });

    if (params.allowAttackDefenseDetail && hasAttackOrDefense(last) && !hasThreePatterns(last)) {
      lastHits = ["🍚/🧂の片側欠損"];
      continue;
    }

    if (!forbidden) return last;
    lastHits = findForbiddenHits(last, forbidden);
    if (lastHits.length === 0) return last;
  }

  if (stance === "zubatto") return forceCasual(last, dialect);
  return last;
}

type QaBucket = "subject" | "audit" | "other";
type QaCand = KnowledgeItem & { _bucket: QaBucket; _score: number };

function scoreQaShallow(qa: KnowledgeItem, message: string): number {
  const m = (message ?? "").trim();
  if (!m) return 0;

  const tokens = messageTokens3(m);
  const hay = ((qa.title ?? "") + "\n" + (qa.content ?? "")).toLowerCase();

  let s = 0;
  for (const t of tokens) if (t && hay.includes(t.toLowerCase())) s += 1;

  // 2文字のドメイン語（売上/現金など）は tokens3 で落ちるので、ここで拾う
  const dom2 = ["売上", "現金", "外注", "交際費", "給与", "日当", "入金", "請求", "納品", "検収","検収","領収書","レシート"];
  for (const w of dom2) {
    if (m.includes(w) && hay.includes(w)) s += 2; // 強めに
  }

  // amount / リスク系の軽いブースト
  if (/(いくら|なんぼ|上限|どこまで|安全|セーフ|アウト|リスク|グレー|危ない)/.test(m)) {
    if (/(いくら|なんぼ|上限|どこまで|安全|セーフ|アウト|リスク|グレー|危ない)/.test(hay)) s += 2;
  }
  return s;
}

function extractIntentPatternsLine(content: string): string {
  const text = (content ?? "").replace(/\r\n/g, "\n");
  const line = text.split("\n").find((l) => l.includes("intent_patterns"));
  return (line ?? "").trim();
}

function extractSummary2Lines(content: string): string {
  const text = (content ?? "").replace(/\r\n/g, "\n");
  const lines = text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  // intent_patterns は薄切りに混ぜる（ある時だけ）
  const intent = extractIntentPatternsLine(text);
  const picked: string[] = [];
  if (intent) picked.push(intent);

  // 「✅要点」「【✅要点】」周辺の2行優先
  const idxKey = lines.findIndex((l) => l.includes("✅要点"));
  if (idxKey >= 0) {
    for (let i = idxKey; i < lines.length && picked.length < 3; i++) {
      const l = lines[i];
      if (l.length > 180) continue;
      picked.push(l);
    }
  }

  // 足りなければ先頭から補う（長すぎる行は捨てる）
  for (const l of lines) {
    if (picked.length >= 3) break;
    if (l.length > 180) continue;
    if (picked.includes(l)) continue;
    picked.push(l);
  }

  // 3行以内に収める（intent + 2行のイメージ）
  const out = picked.slice(0, 3).join(" / ");
  return out.length <= 360 ? out : out.slice(0, 360) + "…";
}

async function fetchCrossQaPool(params: {
  db: any;
  excludeTopics: string[];
  limit: number;
}): Promise<KnowledgeItem[]> {
  const { db } = params;
  const limit = Math.max(50, Math.min(400, params.limit ?? 200));
  const excludeTopics = Array.from(
    new Set((params.excludeTopics ?? []).map((x) => String(x ?? "").trim()).filter(Boolean))
  );
  if (!db) return [];

  let q = db
    .from("knowledge_items")
    .select("id, kind, topic, title, content, amounts, conditions, priority")
    .eq("is_active", true)
    .eq("kind", "qa")
    .lt("priority", 70)
    .order("priority", { ascending: false })
    .limit(limit);

  if (excludeTopics.length > 0) {
    const inList = `(${excludeTopics.map((t) => `"${t.replace(/"/g, '\\"')}"`).join(",")})`;
    q = q.not("topic", "in", inList);
  }

  const { data, error } = await q;
  if (error) return [];
  return (data ?? []) as KnowledgeItem[];
}


function splitQaForHybrid(params: {
  itemsForPrompt: KnowledgeItem[];
  subjectTopic: string;
  auditAxis: boolean;
  message: string;
  candidate50N: number; // 12
}) {
  const { itemsForPrompt, subjectTopic, auditAxis, message, candidate50N } = params;

  const nonQa = (itemsForPrompt ?? []).filter((it) => it.kind !== "qa");
  const qasAll = (itemsForPrompt ?? []).filter((it) => it.kind === "qa");

  const qasSubject = subjectTopic ? qasAll.filter((q) => q.topic === subjectTopic) : [];

  const pickFixed70 = (pool: KnowledgeItem[]) => {
    const cands = pool
      .filter((q) => (q.priority ?? 0) >= 70)
      .map((q) => ({ q, s: scoreQaShallow(q, message) }))
      .sort((a, b) => b.s - a.s || (b.q.priority ?? 0) - (a.q.priority ?? 0));
    return cands[0]?.q ?? null;
  };

  // 70（憲法）固定：まずは subject から1枚（方針どおり）
  const fixed70: KnowledgeItem[] = [];
  const fixedSubject70 = pickFixed70(qasSubject);
  if (fixedSubject70) fixed70.push(fixedSubject70);

  const fixedIds = new Set(fixed70.map((x) => x.id));

  const markBucket = (q: KnowledgeItem): QaCand => {
    const bucket: QaBucket =
      subjectTopic && q.topic === subjectTopic
        ? "subject"
        : auditAxis && q.topic === TOPIC_TAX_AUDIT
        ? "audit"
        : "other";
    return { ...(q as any), _bucket: bucket, _score: scoreQaShallow(q, message) } as QaCand;
  };

  // 50候補：priority<70 だけを候補化（方針どおり）
  const cand50 = qasAll
    .filter((q) => !fixedIds.has(q.id))
    .filter((q) => (q.priority ?? 0) < 70)
    .map(markBucket)
    .sort((a, b) => b._score - a._score || (b.priority ?? 0) - (a.priority ?? 0))
    .slice(0, Math.max(2, Math.min(80, candidate50N)));

  return { nonQa, fixed70, cand50 };
}

async function pick50ByHybridLLM(params: {
  message: string;
  cand50: QaCand[];
}): Promise<{
  selected50: KnowledgeItem[];
  llmOk: boolean;
  llmError: string;
  llmRaw: string;
  reasons: Record<string, string>;
  selectedIds: string[];
}> {
  const { message, cand50 } = params;

  // 候補が少ない時はそのまま上位2つ
  if (!cand50 || cand50.length <= 2) {
    const ids = (cand50 ?? []).slice(0, 2).map((x) => x.id);
    return {
      selected50: (cand50 ?? []).slice(0, 2),
      llmOk: false,
      llmError: "skip:too_few_candidates",
      llmRaw: "",
      reasons: {},
      selectedIds: ids,
    };
  }

  const thin = cand50.map((c) => ({
    id: c.id,
    title: c.title,
    summary: extractSummary2Lines(c.content ?? ""),
    priority: c.priority ?? 0,
    bucket: c._bucket,
  }));

  const llm = await chooseQaByLLM({ message, candidates: thin });

  const idToCand = new Map(cand50.map((c) => [c.id, c]));
  const pickFromIds = (ids: string[]) =>
    ids.map((id) => idToCand.get(id)).filter(Boolean) as QaCand[];

  let selectedIds = (llm.selectedIds ?? []).filter(Boolean);

  // 2枚に満たない/不正なら fallback（上位スコア順）
  if (!llm.ok || selectedIds.length < 2) {
    const fb = cand50.slice(0, 2);
    return {
      selected50: fb,
      llmOk: false,
      llmError: llm.error || "fallback:invalid_llm_selection",
      llmRaw: llm.rawText ?? "",
      reasons: llm.reasons ?? {},
      selectedIds: fb.map((x) => x.id),
    };
  }

  // 重複・候補外を除去して2枚確保
  selectedIds = Array.from(new Set(selectedIds)).filter((id) => idToCand.has(id));
  if (selectedIds.length < 2) {
    const fb = cand50.slice(0, 2);
    return {
      selected50: fb,
      llmOk: false,
      llmError: "fallback:filtered_too_short",
      llmRaw: llm.rawText ?? "",
      reasons: llm.reasons ?? {},
      selectedIds: fb.map((x) => x.id),
    };
  }

  const picked = pickFromIds(selectedIds).slice(0, 2);
  if (picked.length < 2) {
    const fb = cand50.slice(0, 2);
    return {
      selected50: fb,
      llmOk: false,
      llmError: "fallback:pick_failed",
      llmRaw: llm.rawText ?? "",
      reasons: llm.reasons ?? {},
      selectedIds: fb.map((x) => x.id),
    };
  }

  return {
    selected50: picked,
    llmOk: true,
    llmError: "",
    llmRaw: llm.rawText ?? "",
    reasons: llm.reasons ?? {},
    selectedIds: picked.map((x) => x.id),
  };
}


/** ===== meta builders ===== */
function buildPickedQaMeta(items: KnowledgeItem[], limit = 3): PickedQaMeta[] {
  const rows = (items ?? [])
    .filter((it) => it.kind === "qa")
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .slice(0, Math.max(0, Math.min(10, limit)));
  return rows.map((it) => ({
    id: it.id,
    title: it.title,
    priority: it.priority,
    topic: it.topic,
  }));
}
function buildPickedLinesMeta(picked: { attack: KnowledgeLine | null; defense: KnowledgeLine | null }): PickedLineMeta[] {
  const out: PickedLineMeta[] = [];
  if (picked.attack)
    out.push({
      id: picked.attack.id,
      topic: picked.attack.topic,
      lens: picked.attack.lens,
      stance: picked.attack.stance,
      priority: picked.attack.priority,
      role: picked.attack.role ?? null,
    });
  if (picked.defense)
    out.push({
      id: picked.defense.id,
      topic: picked.defense.topic,
      lens: picked.defense.lens,
      stance: picked.defense.stance,
      priority: picked.defense.priority,
      role: picked.defense.role ?? null,
    });
  return out.slice(0, 3);
}

/** ===== debug write ===== */
async function writeDebugEvent(params: { db: any; trace: DebugTrace }) {
  const { db, trace } = params;

  const { error } = await db.from("chat_debug_events").insert({
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

  if (error) {
    console.error("[chat-debug-db-failed]", {
      message: error.message,
      details: (error as any).details,
      hint: (error as any).hint,
      code: (error as any).code,
    });
  }
}


function emitDebug(trace: DebugTrace) {
  console.log(`[chat-trace] ${JSON.stringify(trace)}`);
}

async function fetchPrevDebugLite(
  db: any,
  convId: string
): Promise<{
  path: string;
  lens: string;
  subjectTopic: string;
  axisTopic: string;
  prevNudgeApplied: boolean;
  guardrailAction: string;
  suppressBranding: boolean;
} | null> {
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
      prevNudgeApplied: Boolean(meta.nudge_lines_applied),
       guardrailAction: String(meta.guardrail_action ?? ""),
   suppressBranding: Boolean(meta.suppress_branding),
    };
  } catch {
    return null;
  }
}

async function fetchPrevDebugForPrevUserMessage(
  db: any,
  convId: string,
  prevUserMessage: string | null
): Promise<{
  path: string;
  lens: string;
  subjectTopic: string;
  axisTopic: string;
  prevNudgeApplied: boolean;
  guardrailAction: string;
  suppressBranding: boolean;
} | null> {
  const msg = (prevUserMessage ?? "").trim();
  if (!msg) return null;
  const targetJson = JSON.stringify(msg);
  try {
    // 直近のdebugを少し多めに見て、直前ユーザー発話に対応するものを拾う
    const { data } = await db
      .from("chat_debug_events")
      .select("path, lens, meta, created_at")
      .eq("conversation_id", convId)
      .order("created_at", { ascending: false })
      .limit(25);

    const rows = Array.isArray(data) ? data : [];
    const hit = rows.find((r) => {
      const meta = (r?.meta ?? {}) as any;
      const rawJson = String(meta.topic_raw_json ?? "");
      const raw = String(meta.topic_raw ?? "");
      return rawJson === targetJson || raw === msg;
    });
    if (!hit) return null;
    const meta = (hit.meta ?? {}) as any;
    return {
      path: String(hit.path ?? ""),
      lens: String(hit.lens ?? ""),
      subjectTopic: String(meta.subject_topic ?? ""),
      axisTopic: String(meta.axis_topic ?? ""),
      prevNudgeApplied: Boolean(meta.nudge_lines_applied),
      guardrailAction: String(meta.guardrail_action ?? ""),
      suppressBranding: Boolean(meta.suppress_branding),
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
  const topicMode: "regex" | "llm" =
    (process.env.TOPIC_MODE || "regex") === "llm" ? "llm" : "regex";

  // LLM decision outputs
  let llmOk = false;
  let llmErr = "";
  let llmRaw = "";
  let llmIntent = "";
  let llmConfidence = 0;
  let llmReason = "";
  let llmTopicsNow: string[] = [];
  let llmSubject = "";
  let llmAxis = "";
  let llmAudit = false;
  let llmNudgeLines = false;
  let llmNudgeReason = "";

  try {
    const token = bearer(req);
    if (!token)
      return NextResponse.json(
        { ok: false, error: "Missing bearer token" } satisfies ChatRes,
        { status: 401 }
      );

    const body = await req.json().catch(() => null);

    const message = safeStr(body?.message).trim();
    const idempotencyKey = safeStr(body?.idempotencyKey).trim();
    const conversationIdRaw = safeStr(body?.conversationId).trim();
    const dialect = normalizeDialect(safeStr(body?.dialect).trim());
    const stance = normalizeStance(safeStr(body?.stance).trim() as any);
    const conversationId = conversationIdRaw ? conversationIdRaw : null;

    if (!message)
      return NextResponse.json(
        { ok: false, error: "message is required" } satisfies ChatRes,
        { status: 400 }
      );
    if (!idempotencyKey)
      return NextResponse.json(
        { ok: false, error: "idempotencyKey is required" } satisfies ChatRes,
        { status: 400 }
      );
    if (!isUuid(idempotencyKey))
      return NextResponse.json(
        { ok: false, error: "idempotencyKey must be uuid" } satisfies ChatRes,
        { status: 400 }
      );

    const url = mustEnv("NEXT_PUBLIC_SUPABASE_URL");
    const anon = mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

    const authClient = createClient(url, anon, { auth: { persistSession: false } });
    const { data: userRes, error: userErr } = await authClient.auth.getUser(token);
    if (userErr || !userRes?.user)
      return NextResponse.json(
        { ok: false, error: "Invalid session" } satisfies ChatRes,
        { status: 401 }
      );
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
  const nowIso = new Date().toISOString();

  // 既存 conversationId が来てれば使う（body の名前はあなたの route.ts に合わせて）
  let convId: string | null =
    typeof (body as any)?.conversationId === "string" ? String((body as any).conversationId) : null;

  try {
    // ① conversation を確保
    if (!convId) {
      const { data: conv, error: convErr } = await db
        .from("conversations")
        .insert({
          user_id: user.id,
          title: "（無題）",
          summary: "",
          summary_updated_at: nowIso,
        })
        .select("id")
        .single();

      if (convErr) throw convErr;
      convId = conv?.id ? String(conv.id) : null;
    }

    // ② messages に user / assistant を保存（loadMessagesで消えない）
    if (convId) {
      const rows = [
        {
          user_id: user.id,
          conversation_id: convId,
          role: "user",
          content: message,
          created_at: nowIso,
        },
        {
          user_id: user.id,
          conversation_id: convId,
          role: "assistant",
          content: gr.userMessage,
          created_at: nowIso,
        },
      ];

      const { error: mErr } = await db.from("messages").insert(rows);
      if (mErr) throw mErr;
    }

    // ③ chat_debug_events（共通関数経由で書く：形式を統一＆失敗理由をログで見える化）
await writeDebugEvent({
  db,
  trace: {
    userId: user.id,
    convId: convId || "", // ★DebugTraceはstringなので空文字で寄せる
    messageHead: message.slice(0, 80),

    topicsNow: [],
    inferredTopic: "",
    lens: "system",

    followup: false,
    shifted: false,

    usedKnowledge: false,
    usedLinesPick: false,

    followupPhase: false,
    followupExplicit: false,
    lineRequest: false,
    forceNormalAnswer: false,

    path: "guardrail:block",
    meta: {
      guardrail_action: "block",
      guardrail_reason: String((gr as any)?.reason ?? ""),
      suppress_branding: true,
      suppress_branding_reason: `rule:block:${String((gr as any)?.reason ?? "")}`,
      dialect,
      stance,
    },
  },
});


  } catch (e) {
    // DB側でコケても “ユーザーには回答返す”
    // （ここで throw すると again thinking 地獄になる）
  }

  // ④ レスポンス（フロントが判別できるフラグ付き）
  return NextResponse.json(
    {
      ok: true,
      plan,
      used_talks: null,
      limit_talks: null,
      conversation_id: convId,
      message: gr.userMessage,
      guardrail_block: true,
      guardrail_action: "block",
    } as any,
    { status: 200 }
  );
}

// ===== suppressBranding（LLM判定で確定）=====
let suppressBranding = false;
let suppressBrandingReason = "unset";


    const convId = await ensureConversationId({
      db,
      userId: user.id,
      conversationId,
      firstUserMessage: message,
    });

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
        const candidates = rows
          .map((r) => (r.content ?? "").trim())
          .filter((c) => c && c !== current);
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

      // 直前ユーザー発話に紐づくdebugを優先（混線防止）。無ければ従来の最新1件。
      const prevDebug =
        (await fetchPrevDebugForPrevUserMessage(db, convId, prevUserMessage)) ??
        (await fetchPrevDebugLite(db, convId));

      const clarify = detectClarifyPrevAnswer(message, prevAssistantMessage);
      const lineRequest = isLineRequest(message);
      const clarifyPrevAnswer = Boolean(clarify.ok) && !lineRequest;

      // followup 判定（短文誤爆抑制）
      const shiftedRaw = topicShiftLikelyLite(prevUserMessage, message);
      const followupOnlyRaw = isFollowupOnlyText(message);
      const followupOnly =
        followupOnlyRaw && !clarifyPrevAnswer && !looksQuestionish(message) && !shiftedRaw;

      const weakUtterance = isWeakUtterance(message);
      const followupExplicitRaw = wantsAttackDefenseDetail(message, prevUserMessage);
      const followupExplicit = followupExplicitRaw && !clarifyPrevAnswer;

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

      // ===== suppressBranding（順番重要：prevDebug と continuationLike が確定してから）=====
      {
        // 前回危険（inject/block/suppress）で、今回が“続きっぽい”なら抑制を持ち越す
        const prevRisk =
          Boolean((prevDebug as any)?.suppressBranding) ||
          (prevDebug as any)?.guardrailAction === "inject" ||
          (prevDebug as any)?.guardrailAction === "block";

        const carryRisk = prevRisk && continuationLike && !shiftedRaw;

        const sup = await decideSuppressBrandingByLLM({
          message,
          prevUser: prevUserMessage ?? null,
          prevAssistant: prevAssistantMessage ?? null,
          guardrail: gr, // blockは上でreturn済み。ここは inject|none
          carryRisk,
        } as any);

        suppressBranding = Boolean((sup as any).suppressBranding);
        suppressBrandingReason = String((sup as any).reason ?? "llm:no_reason");
      }

let llmShiftCue = false;
let llmShiftCueReason = "";

// ★ implicitShift は LLM結果も反映して後で確定する
let implicitShift = false;

let forceNormalAnswer = followupPhase && !followupExplicit && !followupOnly && !lineRequest && !weakUtterance;
if (clarifyPrevAnswer && !lineRequest) forceNormalAnswer = true;

// topic debug (regex)
const topicsNowDbg = inferTopicsDebug(message, { max: 3 });
const topicsNowRegex = topicsNowDbg.topics;

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

// ===== 1) decide topic (axis/subject) =====
let decision = decideAxisSubject({
  message,
  topicsNow: topicMode === "regex" ? topicsNowRegex : [],
  topicsPrev,
  prevAssistantMessage,
  recentUserMsgs,
  continuationLike,
  llmNudgeLines: false,
  llmNudgeReason: "",
});

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
    llmSubject = llm.decision.subjectTopic ?? "";
    llmAxis = llm.decision.axisTopic ?? "";
    llmAudit = Boolean(llm.decision.auditAxis);
    llmNudgeLines = Boolean(llm.decision.nudgeLines);
    llmNudgeReason = String(llm.decision.nudgeReason ?? "");

    // ★NEW: 話題転換の空気（キーワード依存を避ける）
    llmShiftCue = Boolean((llm.decision as any).shiftCue);
    llmShiftCueReason = String((llm.decision as any).shiftCueReason ?? "");

    decision = decideAxisSubject({
      message,
      topicsNow: llmTopicsNow.slice(0, 3),
      topicsPrev,
      prevAssistantMessage,
      recentUserMsgs,
      continuationLike,
      llmNudgeLines,
      llmNudgeReason,
    });

    // 最終反映（LLMが言うsubject/axis/auditがあるなら優先）
    decision = {
      ...decision,
      subjectTopic: llmSubject || (decision as any).subjectTopic,
      axisTopic: llmAxis || (decision as any).axisTopic,
      auditAxis: llmAudit,
      taxAuditSticky: llmAudit,
      reason: `llm:${llmIntent}:${llmConfidence.toFixed(2)}:${llmReason || ""}`,
      nudgeLines: llmNudgeLines,
      nudgeReason: llmNudgeReason,
    } as any;
  } else {
    llmOk = false;
    llmErr = llm.error;
  }
}

const TOPICS_NOW_DENYLIST = new Set(["制度基準", "一般論"]);

// ★ 最終的に使う topicsNow はここで確定（LLMでもregexでも同じフィルタを通す）
const topicsNowRaw =
  topicMode === "llm"
    ? (llmOk ? (llmTopicsNow ?? []).slice(0, 3) : topicsNowRegex)
    : topicsNowRegex;

const topicsNow = (topicsNowRaw ?? [])
  .map((t) => String(t ?? "").trim())
  .filter(Boolean)
  .filter((t) => !TOPICS_NOW_DENYLIST.has(t))
  .slice(0, 3);



// ★ここで implicitShift を確定（LLM shiftCue を反映）
implicitShift =
  (!weakUtterance || llmShiftCue) &&
  !clarifyPrevAnswer &&
  !continuationLike &&
  shiftedRaw &&
  !isShortAckLike(message);
  


      // ===== 2) normalize subject (single source of truth) =====
      let subjectTopic = String((decision as any).subjectTopic ?? "").trim();
      let auditAxis = Boolean((decision as any).auditAxis);

      // “合言葉の直後” は主題を prev で固定（聞き返し禁止）
      const prevNudgeApplied = Boolean(prevDebug?.prevNudgeApplied);
      const prevSubject = String(prevDebug?.subjectTopic ?? "").trim();
      const lineRequestByPhrase = isLineRequest(message);

      if (!subjectTopic && prevNudgeApplied && lineRequestByPhrase && prevSubject) {
        subjectTopic = prevSubject;
      }

      // 弱発話/合言葉/短文追撃 で subject が空なら、prevSubject を借りる（KB借りより先）
// ※ ただし LLM が「話題転換の空気あり」と判断したら借りない（キーワード依存を避ける）
const shouldBorrowSubject =
  !llmShiftCue &&
  !subjectTopic &&
  Boolean(prevSubject) &&
  (weakUtterance ||
    isShortAckLike(message) ||
    lineRequestByPhrase ||
    followupOnly ||
    followupPhase);

if (shouldBorrowSubject) {
  subjectTopic = prevSubject;
}



      // implicit shift で sticky を外す
      const hasAuditWordsNow = hasTaxAuditWordsLite(message);
      const implicitShiftUnstick =
        implicitShift &&
        Boolean((decision as any)?.taxAuditSticky) &&
        !hasAuditWordsNow &&
        !lineRequest &&
        !followupExplicit &&
        !followupOnly;

      if (implicitShiftUnstick) {
        auditAxis = false;
      }

      // axisTopic
      const historyAxisRaw = implicitShift ? "" : inferTopicFromHistory(prevUserMessage, prevAssistantMessage) || "";
      const decisionAxisCandidate = (() => {
        const x = String((decision as any).axisTopic ?? "").trim();
        if (!x) return "";
        if (x === TOPIC_TAX_AUDIT) return "";
        return x;
      })();

      const axisTopic = auditAxis ? TOPIC_TAX_AUDIT : subjectTopic || decisionAxisCandidate || historyAxisRaw || "";

      const shifted =
  llmShiftCue ? true :
  shouldBorrowSubject ? false :
  implicitShift ? true :
  Boolean((decision as any)?.taxAuditSticky) ? false :
  shiftedRaw;



      // ===== 3) lens =====
      const lensInputUsePrev = (followupOnly || weakUtterance) && Boolean(prevUserMessage);
      const lensMessage =
        lensInputUsePrev && prevUserMessage ? String(prevUserMessage) : message;

      const lensRule: Lens = inferLensWithContext({
        message,
        axisTopic,
        fallbackPrevUser: prevUserMessage ?? null,
        usePrevInstead: lensInputUsePrev,
      });

      const usedSajikagen = /さじかげん/.test(message ?? "");

      // ★ followup の合言葉は “lensMessage（前の実質問）” を見て判定する
       const lensLLM = await inferLensByLLM({ message: lensMessage });

      // ★ lensブレ対策：
      // followup/弱発話は「レンズ再推定」ではなく「前の実質問を引き継ぐ」場面。
      // LLM lens を採用すると system に誤爆しやすいので、ここは lensRule を優先する。
      const preferRuleLens =
        weakUtterance ||
        followupOnly ||
        followupPhase ||
        lineRequest ||
        isShortAckLike(message);

      const lensMerged: Lens =
       preferRuleLens ? lensRule : (lensLLM.confidence >= 0.6 ? lensLLM.lens : lensRule);
      let lensPre: Lens = lensMerged;

      // need_lines でも「金額相談の根拠」がある時だけ amount を強める（無条件上書きはしない）
      if (llmIntent === "need_lines" && isAmountAsk(lensMessage)) lensPre = "amount";
      if (llmIntent === "clarify") lensPre = "substance";

      const lens: Lens = adjustLensByConversation({
        lens: lensPre,
        lensMessage,
        subjectTopic,
        axisTopic,
        llmIntent,
      });

      // ===== 4) lines gating =====
      const prevWasLines = prevDebug?.path === "followup_lines";
      const prevLens = (prevDebug?.lens ?? "").trim();
      const lensChanged = Boolean(prevLens) && prevLens !== lens;

      const suppressLinesByShortAck = isShortAckLike(message) && !lineRequest;
      const allowLinesByContinuation = prevWasLines && isShortAckLike(message);

      const lineRequestEffective = (lineRequest || allowLinesByContinuation) && !suppressLinesByShortAck;

      // LLMモード：subjectが空なら Lines を出さない（ズレ防止）
      const linesBlockedNoSubject = topicMode === "llm" && llmOk && lineRequestEffective && !subjectTopic;

      const allowLines = lineRequestEffective && !linesBlockedNoSubject;

      if (lineRequestEffective) forceNormalAnswer = false;

      const keepLines = lineRequestEffective || lensChanged;
      const linesCooldown = prevWasLines && !keepLines;
      if (linesCooldown) forceNormalAnswer = true;

      // ★ keep_reason の整合（applied とズレない）
      const linesKeepReason = lineRequestEffective
        ? linesBlockedNoSubject
          ? "keep:line_request_blocked:llm_no_subject"
          : "keep:line_request"
        : lensChanged
        ? `keep:lens_changed:${prevLens}->${lens}`
        : linesCooldown
        ? "cooldown:prev_was_lines"
        : "no_keep";

      // ===== 5) knowledge fetch =====
      const globalRules = await retrieveGlobalRules({ db });

      // topicsNow0 は “KB拾いの補助”として subject/topicNow を使う（空で突っ込まない）
      const topicsNowForKb = topicsNow.length > 0 ? topicsNow : subjectTopic ? [subjectTopic] : [];
      let topicKbItems = await retrieveKnowledgeByBuckets({
        db,
        auditAxis,
        subjectTopic,
        topicsNow: topicsNowForKb,
        maxTotal: 10,
      });

      const linesPrefaceQa = pickLinesPrefaceQa(topicKbItems);

      const topicKbItemsForPrompt0 = followup
        ? topicKbItems
        : topicKbItems.filter((x) => !(x.kind === "qa" && (x.title ?? "").includes(LINES_PREFACE_TAG)));

      // ★ QA候補は subjectTopic の全QAを土俵に上げる
const topicQaAll = subjectTopic
  ? await fetchAllQaByTopic({ db, topic: subjectTopic })
  : [];

      const hybridBase = splitQaForHybrid({
  itemsForPrompt: topicQaAll,   // ← 新しく取る
  subjectTopic,
  auditAxis,
  message: lensMessage,      // followupは「実質問」を使う
  candidate50N: 50,
});

// ===== cross candidates (ilike) =====
      // ===== hybrid cand policy =====
      // subject(topic)は厚め、crossは6固定（ノイズ抑制）
      const HYBRID_CAND_TOTAL = 50;
      const HYBRID_CROSS_N = 10;
      const HYBRID_TOPIC_N = HYBRID_CAND_TOTAL - HYBRID_CROSS_N; 
      
      // ★ cross検索は「今回のユーザー発話」で固定（前の話題混入を防ぐ）
      // ★ cross召集は「LLMに寄せる」：DBから横断プールを機械取得 → LLMで10枚選ぶ
      // （subjectTopic と 税務調査 は除外：重複は横断の意味がない）
      const crossMessage = message;
      const crossPool = await fetchCrossQaPool({
        db,
        excludeTopics: [subjectTopic, TOPIC_TAX_AUDIT].filter(Boolean),
        limit: 400,
      });

      const crossThin = (crossPool ?? []).map((q) => ({
        id: q.id,
        title: String(q.title ?? ""),
        summary: extractSummary2Lines(String(q.content ?? "")),
        priority: q.priority ?? 0,
        bucket: "other" as const,
      }));

      const crossPick = await chooseQaByLLM({
        message: crossMessage,
        candidates: crossThin,
        pickN: HYBRID_CROSS_N,
        preferBucket: "other",
      });

            // topic系 24 + cross系 6 → 合計30（重複は除外、足りなければtopic系で埋める）
      const topicTopN = (hybridBase.cand50 ?? []).slice(0, HYBRID_TOPIC_N);
      const usedIds0 = new Set<string>([
        ...(hybridBase.fixed70 ?? []).map((x) => x.id),
        ...topicTopN.map((x) => x.id),
      ]);

      const crossPickedIds = new Set<string>(
        (crossPick.selectedIds ?? []).map((x) => String(x ?? "").trim()).filter(Boolean)
      );

      const cross50 = (crossPool ?? [])
        .filter((q) => q && q.kind === "qa")
        .filter((q) => (q.priority ?? 0) < 70) // 50帯だけ
        .filter((q) => crossPickedIds.has(q.id))
        .filter((q) => !usedIds0.has(q.id))
        .map((q) => {
          const score = scoreQaShallow(q, crossMessage);
          return { ...(q as any), _bucket: "other", _score: score } as QaCand;
        });

      // topicTopN を確実に先頭に
      const candTmp: QaCand[] = [...topicTopN];
      for (const x of cross50) if (x && !candTmp.some((y) => y.id === x.id)) candTmp.push(x);

      // 足りなければ残りを topic pool から埋める
      const pool = hybridBase.cand50 ?? [];
      for (const x of pool) {
        if (candTmp.length >= HYBRID_CAND_TOTAL) break;
        if (!x) continue;
        if (candTmp.some((y) => y.id === x.id)) continue;
        candTmp.push(x);
      }
      const cand50Final = candTmp.slice(0, HYBRID_CAND_TOTAL);

      // ★ 選抜も「今回のユーザー発話」で固定（followup救済は別レイヤ）
      const llmPick = await pick50ByHybridLLM({
        message: crossMessage,
        cand50: cand50Final,
      });

const pickedQaForPrompt: KnowledgeItem[] = [
  ...hybridBase.fixed70,
  ...llmPick.selected50,
].slice(0, 3); // 70×1 + 50×2

// ===== QA anchor（picked_qa内のドンピシャ判定）=====
const pickedQaOnly = (pickedQaForPrompt ?? []).filter((x) => x && x.kind === "qa");
const anchorCandidates = pickedQaOnly.slice(0, 3).map((q) => ({
  id: q.id,
  title: String(q.title ?? ""),
  summary: extractSummary2Lines(String(q.content ?? "")),
  priority: q.priority ?? 0,
  topic: String(q.topic ?? ""),
}));

const anchor = await decideAnchorQaByLLM({
  message: String(message ?? ""),
  candidates: anchorCandidates,
});

const anchorQaId = anchor.ok ? String(anchor.anchorQaId ?? "").trim() : "";
const anchorQa = anchorQaId ? pickedQaOnly.find((q) => q.id === anchorQaId) ?? null : null;

const pickedQaIds = new Set(pickedQaForPrompt.map((x) => x.id));
const topicKbItemsForPrompt: KnowledgeItem[] = [
  ...hybridBase.nonQa,
  ...((topicKbItemsForPrompt0 ?? []).filter((it) => it.kind === "qa" && pickedQaIds.has(it.id))),
];

// bucket counts（picked側でカウント）
const cSubject = pickedQaForPrompt.filter((x) => x.topic === subjectTopic).length;
const cAudit = pickedQaForPrompt.filter((x) => x.topic === TOPIC_TAX_AUDIT).length;
const cOther = pickedQaForPrompt.length - cSubject - cAudit;


      // ===== meta（判定順に並べる：まず「事実」→「決定」→「取得」→「出力」） =====
      const meta: DebugMeta = {
        // input
        topic_raw: message,
        topic_raw_json: JSON.stringify(message),
        topic_codepoints_tail: codepointsTail(message, 30),
        topic_normalized: topicsNowDbg.normalized,
        topic_hits: topicsNowDbg.hits,

        // prev
        prev_user_head: dbgHead(prevUserMessage ?? "", 80),
        prev_user_len: (prevUserMessage ?? "").length,
        prev_debug_path: prevDebug?.path ?? "",
        prev_debug_lens: prevDebug?.lens ?? "",

        // followup/clarify
        weak_utterance: weakUtterance,
        clarify_prev_answer: clarifyPrevAnswer,
        clarify_term: clarify.term || "",
        clarify_matched: clarify.matched || "",

        // topic decision
        topic_mode: topicMode,
        llm_topic_ok: llmOk,
        llm_topic_error: llmErr,
        llm_topic_raw: llmOk
  ? clampForContext(
      JSON.stringify(
        {
          subjectTopic: llmSubject,
          axisTopic: llmAxis,
          auditAxis: llmAudit,
          topicsNow: llmTopicsNow,
          intent: llmIntent,
          confidence: llmConfidence,
          reason: llmReason,
          nudgeLines: llmNudgeLines,
          nudgeReason: llmNudgeReason,
          shiftCue: llmShiftCue,
          shiftCueReason: llmShiftCueReason,
        },
        null,
        0
      ),
      800
    )
  : (llmRaw ? clampForContext(llmRaw, 800) : ""),
        llm_intent: llmIntent,
        llm_confidence: llmConfidence,
        llm_reason: llmReason,
                guardrail_action: gr.action,
        guardrail_reason: String((gr as any)?.reason ?? ""),
        suppress_branding: Boolean(suppressBranding),
        suppress_branding_reason: String(suppressBrandingReason ?? ""),
        dialect,
        stance,

        // ★NEW: shift cue（LLM）
llm_shift_cue: Boolean(llmShiftCue),
llm_shift_cue_reason: String(llmShiftCueReason ?? ""),
        



        subject_topic: subjectTopic,
        axis_topic: axisTopic,
        audit_axis: auditAxis,
        prefer_rule_lens: preferRuleLens,

        borrowed_prev_topic: Boolean(shouldBorrowSubject),
        implicit_shift: Boolean(implicitShift),
        implicit_shift_unstick: Boolean(implicitShiftUnstick),
        tax_audit_sticky_reason: implicitShiftUnstick
          ? `implicit_shift_unstick:${String((decision as any).reason ?? "")}`
          : String((decision as any).reason ?? ""),

        // lens decision
        lens_message_head: dbgHead(lensMessage, 80),
        lens_rule: lensRule,
        lens_llm: lensLLM.lens,
        lens_llm_confidence: lensLLM.confidence,
        lens_pre: lensPre,
        lens_final: lens,

        // lines gating
        line_request_effective: Boolean(lineRequestEffective),
        allow_lines: Boolean(allowLines),
        lines_keep_reason: linesKeepReason,
        lines_cooldown_applied: Boolean(linesCooldown),
        lines_blocked_no_subject: Boolean(linesBlockedNoSubject),
        lines_suppressed_short_ack: Boolean(suppressLinesByShortAck),

        // lines ctx/pick（デフォルト：未試行/失敗）
        topic_for_lines: "",
        lens_for_lines: lens,
        lines_pick_attempted: false,
        lines_pick_success: false,
        lines_pick_lens_used: null,
        picked_lines: [],

        // knowledge
        kb_bucket_counts: { subject: cSubject, audit: cAudit, other: cOther },
        picked_kb_items: (topicKbItemsForPrompt ?? []).slice(0, 10).map((it) => ({
          id: it.id,
          kind: it.kind,
          topic: it.topic,
          title: it.title,
          priority: it.priority,
        })),
        picked_qa: buildPickedQaMeta(pickedQaForPrompt, 10),

         // anchor（picked_qa内ドンピシャ判定）
        qa_anchor_llm_ok: Boolean(anchor.ok),
        qa_anchor_llm_error: String(anchor.error ?? ""),
        qa_anchor_llm_raw: anchor.rawText ? clampForContext(String(anchor.rawText), 800) : "",
        qa_anchor_id: anchorQaId || "",
        qa_anchor_confidence: anchor.ok ? anchor.confidence : 0,
        qa_anchor_reason: String(anchor.reason ?? ""),
        qa_anchor_applied: Boolean(anchorQaId),
         // cross (LLM召集)
        qa_cross_pool_n: (crossPool ?? []).length,
        qa_cross_llm_ok: Boolean(crossPick.ok),
        qa_cross_llm_error: String((crossPick as any).error ?? ""),
        qa_cross_llm_raw: String((crossPick as any).rawText ?? ""),
        qa_cross_selected_ids: (crossPick.selectedIds ?? []).slice(0, 10),
        qa_cross_selected_reasons: crossPick.reasons ?? {},
        qa_cross_candidates_50: (cross50 ?? []).slice(0, 6).map((c) => ({
          id: c.id,
          title: c.title,
          topic: c.topic,
          priority: c.priority,
          score: c._score,
        })),

                qa_hybrid_candidate_n: HYBRID_CAND_TOTAL,
       qa_hybrid_candidates_50: (cand50Final ?? []).slice(0, HYBRID_CAND_TOTAL).map((c) => ({
          id: c.id,
          title: c.title,
          topic: c.topic,
          priority: c.priority,
          bucket: c._bucket,
          score: c._score,
        })),
        qa_hybrid_llm_ok: Boolean(llmPick.llmOk),
        qa_hybrid_llm_error: String(llmPick.llmError ?? ""),
        qa_hybrid_llm_raw: llmPick.llmRaw ? clampForContext(llmPick.llmRaw, 800) : "",
        qa_hybrid_selected_ids: llmPick.selectedIds ?? [],
        qa_hybrid_selected_reasons: llmPick.reasons ?? {},

        // output flags（後で埋める）
        used_sajikagen: usedSajikagen,
        built_head: "",
        answer_has_rice: false,
        answer_has_salt: false,
        answer_has_attack_plain: false,
        answer_has_defense_plain: false,
        answer_head: "",
        answer_full: "",
        nudge_lines_llm: Boolean((decision as any).nudgeLines),
        nudge_lines_reason: String((decision as any).nudgeReason ?? ""),
        nudge_lines_applied: false,
      };

      let usedLinesPick = false;
      let path: DebugTrace["path"] = "normal_llm";

      // ===== A) followup_lines（Linesのみ：取れなければ🍚🧂体裁に入らない） =====
      if (!answer && allowLines && !forceNormalAnswer && (subjectTopic || axisTopic)) {
        const header = stance === "zubatto" ? "判断の軸だけ整理する。" : "判断の軸だけ整理します。";
        const topicForLines = subjectTopic || axisTopic;

        meta.topic_for_lines = topicForLines;
        meta.lens_for_lines = lens;
        meta.lines_pick_attempted = true;

        
// 金額レンジの続きは amount Lines を優先する（回答のlensとは責務を分ける）
        const lensForLines: Lens = isAmountAsk(lensMessage) ? "amount" : lens;
        meta.lens_for_lines = lensForLines;

        const picked = await retrieveKnowledgeLines({
          db,
          topic: topicForLines,
          lens: lensForLines,
          messageForMatch: lensMessage, // followupは「実質問」をマッチ材料にする
        });

        meta.lines_pick_lens_used = picked.lensUsed;

        const built = buildFollowupAnswerFromLines(picked);

        if (built) {
          usedLinesPick = true;
          path = "followup_lines";
          meta.lines_pick_success = true;
          meta.picked_lines = buildPickedLinesMeta({ attack: picked.attack, defense: picked.defense });
          meta.built_head = dbgHead(built, 240);

          const pre = buildLinesPreamble({
            topic: topicForLines,
            axisTopic,
            dialect,
            stance,
            qa: linesPrefaceQa,
          });

          const footer = followupFooter(axisTopic, dialect, stance);

          
         // ✅ inquiry（🔎）は廃止したので parts はここで組み立て直す
          const parts: string[] = [];
          parts.push(header, "", pre.text, "", built);
          if (footer) parts.push("", footer);

          answer = postProcessAnswer(parts.join("\n").trim(), dialect, stance, {
            usedKnowledge: true,
            allowAttackDefenseDetail: true,
            suppressBranding,
          });
        } else {
          // ★ Lines が取れない＝偽🍚🧂は禁止。normal_llm に落とす（メタだけ残す）
          usedLinesPick = false;
          meta.lines_pick_success = false;
          meta.picked_lines = [];
        }
      }

      // ===== B) topic未確定だけ clarify（弱発話の時だけ）=====
      const needTopicClarify =
        !answer &&
        !axisTopic &&
        !subjectTopic &&
        topicsNow.length === 0 &&
        topicKbItemsForPrompt.length === 0 &&
        (followupOnly || weakUtterance);

      // ★ topicClarifyInquiry は固定の選択肢羅列をやめる（LLMに自然誘導させる）
      const topicClarifyInquiry = "";

      const pickedQa = pickBestQaPreferSubject({
        items: topicKbItemsForPrompt,
        message,
        subjectTopic,
        axisTopic,
      });

      const bestQa = pickedQa.qa;

      const isQaMore = topicMode === "llm" && llmOk && llmIntent === "qa_more";
      let bestQaForKeypoint = bestQa;

      if (isQaMore) {
        const picked = (pickedQaForPrompt ?? []).filter((x) => x.kind === "qa");
        if (picked.length >= 2) bestQaForKeypoint = picked[1];
      }

 // ===== QA採用スイッチ（自然会話のため）=====
      const qaUse =
        topicKbItemsForPrompt.length > 0 &&
        !weakUtterance &&
        !isShortAckLike(message) &&
        (
          auditAxis ||
          llmIntent === "qa_more" ||
          llmIntent === "qa_first" ||
          llmIntent === "clarify" ||
          isAmountAsk(lensMessage) ||
          /(安全|危ない|リスク|グレー|大丈夫|アウト|セーフ|どこまで|上限|限界|レンジ|幅)/.test(lensMessage)
        );

      const qaKeyPointRule = (qaUse && bestQaForKeypoint) ? qaToKeyPointRule(bestQaForKeypoint, 2) : null;
      if (qaKeyPointRule && bestQaForKeypoint) {
        meta.qa_keypoint_used_title = bestQaForKeypoint.title;
        meta.qa_keypoint_used = qaKeyPointRule;
        meta.qa_pick_reason = isQaMore ? `${pickedQa.reason}|qa_more:second_qa` : pickedQa.reason;
      }

           


      // ===== C) normal_llm（LLMは🍚🧂を生成しない。LinesはLinesのみ） =====
      if (!answer) {
        const usedKnowledge = topicKbItemsForPrompt.length > 0;

        // ★ ここが肝：LLMに🍚🧂を作らせない（偽Lines根絶）
        const allowAttackDefenseDetailEffective = false;

         const outputRules = buildOutputRules({ allowAttackDefenseDetail: allowAttackDefenseDetailEffective });

        // ===== “前向き締め” の許可（最後が⚠️で終わる印象を和らげる）=====
        // ※地雷系（suppress/inject/block）や Lines 回答ではやらない
        const allowPositiveClose =
          gr.action === "none" &&
          !suppressBranding &&
          !usedLinesPick &&
          !lineRequestEffective &&
          !followupExplicit &&
          !followupOnly &&
          !weakUtterance &&
          // すでに inquiryOverride（🔎確認）を強制する場面は付け足さない
          !needTopicClarify;

        const positiveCloseRule = allowPositiveClose
          ? [
              "【締め方】回答の最後が⚠️注意や強い断定で終わりそうなら、最後に3行以内で前向きに締めてよい。",
              "【締め方】締めの3行以内は「次の一手（まず確認すること）」か「軽い確認質問（1つ）」のどちらか。もしくは会話の流れ次第では両方。選択肢の羅列は禁止。",
              "【締め方】押し売りや営業トークは禁止。文章は3行以内で、短め。",
            ].join("\n")
          : null;

        const kbGlobalBlock = formatKnowledgeBlock(globalRules);
        const kbTopicBlock = qaUse ? formatKnowledgeBlock(topicKbItemsForPrompt) : "";

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
            ? [
                "重要：制度（規程/届出/要件）の説明だけで終わらず、最初に『実態の地雷（運用のズレ）』を1つ提示してから制度の話に入る。ネット一般論の羅列は禁止。",
              ]
            : [];

        const amountBias =
          lens === "amount"
            ? [
                 // ★共通骨格：評価しない／レンジ創作しない／軸はQAに寄せる
                // 評価ラベル禁止
        "重要：金額の相談でも、初回回答では『攻め/守り/危険』などの評価ラベルを付けない。提示額に対する善悪判定を出さず、判断軸だけ整理する。",

        // レンジ創作禁止
        "重要：こちらで『○万〜○万』の数値レンジを勝手に作らない（提示額を下限にして上限を創作するのも禁止）。",

        // 地雷の扱い（ここが修正版）
        "地雷（揉めやすいポイント）は、採用されたQAに書かれている内容の範囲内でのみ出す。共通ルールでトピック固有の地雷を決め打ちしない。",

        // 線引きはLinesへ
        "攻め/守りの具体的な線引き（どこまで・上限）は、ユーザーがLinesを求めたときだけ出す。初回はそこまで踏み込まない。",
              ]
            : [];

        const auditIntakeHint =
          axisTopic === TOPIC_TAX_AUDIT && /(最初|初動|電話|連絡|窓口|誰に)/.test(message)
            ? [
                "重要：顧問税理士がいる前提。税務調査の初動連絡は税理士宛/会社宛どちらもあり得るが、社長が単独で抱えない。「税理士に確認して折り返す」でOK。",
              ]
            : [];

        const clarifyBias =
          topicMode === "llm" && llmOk && llmIntent === "clarify"
            ? [
                "重要：主語が特定できていない。特定トピック（交際費・外注・出張手当など）の一般論・金額例・セーフ/アウト判断を出さない。一般整理は抽象度高く2行まで。",
                "clarify では『〜円まで』など数値の線引き・セーフ/アウト判定を出さない。書くのは『判断軸』と『状況を特定するための質問』だけ。",
                "最後は『やわらかい質問を1つか３つ』で締める（詰問口調禁止）。",
                "質問の直後に、ユーザーが答えやすい短い例を1つか２つだけ添える。",
                "補足：picked_qa がある場合は、そのQAが示す判断軸（相手/目的/頻度/証憑/名義など）に沿った質問に寄せる（QA名やタイトルは書かない）。",
              ]
            : [];

// ✅ 会話的な締め（LLMフリー / 記号なし / 深掘り誘導）
const wantWarmClose =
  gr.action === "none" &&
  !suppressBranding &&
  !usedLinesPick &&
  !lineRequestEffective &&
  !followupExplicit &&
  !followupOnly &&
  !weakUtterance &&
  (
    implicitShift ||
    (topicMode === "llm" && llmOk && llmIntent === "clarify")
  );

        const warmCloseRule = wantWarmClose
  ? [
      "【締め】必要に応じて、回答の最後に自然な会話調で1〜3行の締めを付けてよい。",
"【締め】記号やラベル（🔎・👉など）は使わない。箇条書きも禁止。",
"【締め】話題が曖昧な場合のみ、一般論か税務論点かをやわらかく交通整理する。",
"【締め】税務前提が明らかな場合は交通整理しない。代わりに、いま触れていない“近接論点”を1〜2個だけ示し、必要なら短い運用イメージ例を1つ添えて軽く問いかける。",
"【締め】同じ軸を繰り返さない。例は1つだけ。断定や数字レンジは禁止。",
    ].join("\n")
  : null;

            const apportionmentExceptionRule =
  subjectTopic === "家事按分"
    ? "【例外】この相談は『家事按分』。個人事業主（自宅兼事務所）の前提が確認できた場合のみ、按分割合の考え方と根拠の残し方を説明してよい。法人の話に戻る場合は按分を持ち出さない。"
    : null;

const noApportionmentBias: string[] = [
  "【原則】法人の相談では『按分』を提案しない（私用混在は給与課税・経済的利益・社内規程/運用設計・科目整理で説明する）。",
];

  // ===== 私的混在：例外可能性の“型”を1つだけ例示 =====
  const privateMixPossibilityBias: string[] =
    subjectTopic === "私的混在・実態論点"
      ? [
          "【私的混在：トーン】否定だけで終わらせず、例外的に整理できる“型”を1つだけ短く例示する（断定しない／数字を出さない）。",
          "【私的混在：例示候補】(a) 会社アカウント等で継続発信し、採用・受注など成果に繋がった実績がある (b) 会社の来客導線（エントランス等）に恒常的に設置され業務目的が説明できる (c) 実際に秘書・事務として稼働し、役割・成果・契約/雇用の形が整っている —— のうち最も当てはまるもの。",
          "【私的混在：言い方】『ゼロではない』の匂いは出すが、セーフ/アウトの判定はしない。必要なら“運用と証拠”に落とす。",
        ]
      : [];

        const anchorRule =
          anchorQa
            ? [
                "【重要：アンカーQA】今回の質問に直撃しているQAが見つかった。以下のQAを回答の主軸に据え、内容を取りこぼさず反映する（要点/注意/具体の一手を優先）。他のQAは補足として使う。アンカーQAに書かれている具体の一手（初動・言い回し・注意）があるなら必ず含める。",
                `【アンカーQA】title: ${String(anchorQa.title ?? "")}`,
                `【アンカーQA】content: ${clampForContext(String(anchorQa.content ?? ""), 900)}`,
              ].join("\n")
            : null;

        const promptPartsBase: PromptParts = {
          context: contextLines,
          injectedRules: [
            ...outputRules,
            ...clarifyBias,
            ...(warmCloseRule ? [warmCloseRule] : []),
            ...(positiveCloseRule ? [positiveCloseRule] : []),
            ...SERVICE_BASE_RULES,
            ...(axisTopic === TOPIC_TAX_AUDIT ? [TAX_AUDIT_ROLE_SPLIT_RULE] : []),
            ...doubleTopicRule,
            ...(anchorRule ? [anchorRule] : []),
            ...(qaKeyPointRule ? [qaKeyPointRule] : []),
            ...auditIntakeHint,
            ...amountBias,
            ...noApportionmentBias,
            ...(apportionmentExceptionRule ? [apportionmentExceptionRule] : []),
            ...privateMixPossibilityBias,
            ...systemBias,
            ...ambiguityBoost,
            ...styleRules,
            ...(kbGlobalBlock ? [kbGlobalBlock] : []),
            ...(kbTopicBlock ? [kbTopicBlock] : []),
          ],
          guardrails: gr.action === "inject" ? gr.guardrailLines : [],
        };

        answer = await generateAnswerStrict({
          message,
          promptPartsBase,
          dialect,
          stance,
          usedKnowledge,
          allowAttackDefenseDetail: allowAttackDefenseDetailEffective,
          subjectTopic,
          topicsNow,
          llmIntent: topicMode === "llm" && llmOk ? llmIntent : null,
          suppressBranding,
        });

        path = "normal_llm";
      }

      answer = stripInternalLeaks(answer);

      // ===== nudge (catchphrase) gate =====
const reAttack = /(^|\n)\s*🍚\s*攻め\s*[:：]\s*\S/;
const reDefense = /(^|\n)\s*🧂\s*守り\s*[:：]\s*\S/;

// nudge 判定用（最終セットは後でやるので、ここでは暫定判定だけ）
const hasAttackPlainBefore = reAttack.test(answer);
const hasDefensePlainBefore = reDefense.test(answer);
const alreadyHasLines = hasAttackPlainBefore || hasDefensePlainBefore;
const alreadyPrompted = /攻め守りで|さじかげんよろ|さじかげんよろしく|さじかげん/.test(answer);

const wantNudgeByLLM = topicMode === "llm" && llmOk && Boolean((decision as any).nudgeLines);

const isPrivateMix =
  subjectTopic === "私的混在・実態論点" ||
  (topicsNow ?? []).includes("私的混在・実態論点");

const allowNudge =
  wantNudgeByLLM &&
  !suppressBranding &&
  !alreadyHasLines &&
  !alreadyPrompted &&
  llmIntent !== "clarify" &&
  llmIntent !== "qa_more" &&  
  !weakUtterance &&
  !isShortAckLike(message) &&
 !isPrivateMix;

if (allowNudge) {
  answer = `${answer}\n\n${catchphraseFor(dialect, stance)}`;
  meta.nudge_lines_applied = true;
} else {
  meta.nudge_lines_applied = false;
}

// ★ここで「最終 answer」に対して1回だけセット（CSVに出すのはこれ）
meta.answer_full = answer;
meta.answer_has_rice = answer.includes("🍚");
meta.answer_has_salt = answer.includes("🧂");
meta.answer_has_attack_plain = reAttack.test(answer);
meta.answer_has_defense_plain = reDefense.test(answer);
meta.answer_head = dbgHead(answer, 200);


      const prevAxisTopic = (prevDebug?.axisTopic ?? "").trim();
      if (implicitShiftUnstick && prevAxisTopic === TOPIC_TAX_AUDIT) {
        answer = insertLineBeforeInquiry(answer, auditEssenceOneLine(dialect, stance));
        meta.audit_essence_injected = true;
      } else {
        meta.audit_essence_injected = false;
      }

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
      return NextResponse.json(
        { ok: false, error: e?.message || "AI failed. Please retry." } satisfies ChatRes,
        { status: 502 }
      );
    }

    const { data, error } = await db.rpc("consume_talk_v2", {
      p_user_id: user.id,
      p_limit: limit,
      p_idempotency_key: idempotencyKey,
    });

    if (error)
      return NextResponse.json(
        { ok: false, error: `consume_talk_v2 failed: ${error.message}` } satisfies ChatRes,
        { status: 500 }
      );

    const usage = (Array.isArray(data) ? data[0] : data) as ConsumeTalkV2Result | null;
    if (!usage)
      return NextResponse.json(
        { ok: false, error: "consume_talk_v2: empty result" } satisfies ChatRes,
        { status: 500 }
      );

    if (!usage.allowed) {
      return NextResponse.json(
        {
          ok: false,
          error: "Monthly quota exceeded",
          used_talks: usage.used_talks,
          limit_talks: usage.limit_talks,
        } satisfies ChatRes,
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
    return NextResponse.json(
      { ok: false, error: e?.message ?? "Unknown error" } satisfies ChatRes,
      { status: 500 }
    );
  }
}
