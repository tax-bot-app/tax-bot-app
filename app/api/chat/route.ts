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

const FORBIDDEN_POLITE = ["です", "ます", "でした", "ません", "ございます", "ください", "いただ", "おります", "でしょう", "ますか", "ですか"];

function forbiddenFor(dialect: Dialect, stance: Stance): string[] | null {
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
      rules.push("関西弁の参謀は“丁寧な関西弁”で統一する（例：〜でっせ／〜でっしゃろ／〜ですわ／〜してはります／〜しときなはれ／〜してもろて）。タメ口（や/で/やな/やろ/ちゃう）は極力使わない。");
      rules.push("標準語の敬語（〜です/〜ますの“標準語文体”）は禁止。丁寧語を使う場合も関西の言い回しで統一する。");
      rules.push("丁寧語・謙譲語を積極的に使う：〜です／〜ます／〜まっせ／〜でございます（多用はせん）／恐れ入りますが／〜いただけますか／〜してもろてもよろしいですか。");
      rules.push("文末の7割以上を丁寧語で終える。『や・で』で終えるのは禁止に近い（例外はツッコミ1回まで）。");
      rules.push("語尾例：〜でっせ／〜でっしゃろ／〜ですわ／〜してはります／〜しときなはれ／〜してもろて／恐れ入りますが〜");
    } else {
      rules.push("語彙・語尾は関西弁の口語。丁寧語（です/ます）は禁止。");
      rules.push("語尾例：や／で／やな／やろ／ちゃう／せやな／〜が無難／アウト寄り／OK寄り");
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

function clampForContext(s: string, n: number) {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n) + "…";
}
type MsgMini = { id: string; role: "user" | "assistant"; content: string; created_at: string };

type Lens = "amount" | "substance" | "system";
type StanceAD = "attack" | "defense";
type RoleKL = "user" | "internal";

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
  path: "followup_lines" | "followup_kb" | "followup_fallback" | "normal_llm";
};

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
      meta: {},
    });
  } catch (e) {
    // ログ失敗では本処理を落とさない
    console.error("[chat-debug-db-failed]", e);
  }
}

function dbgHead(s: string, n = 80) {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n) + "…";
}

function emitDebug(trace: DebugTrace) {
  // 1行JSON（Vercel Logs用）
  console.log(`[chat-trace] ${JSON.stringify(trace)}`);
}


type KnowledgeLine = {
  id: string;
  topic: string;
  stance: StanceAD;
  lens: Lens;
  role?: RoleKL;
  text: string;
  priority: number;
};

function isFollowupOnlyText(m: string): boolean {
  if (!m) return false;
  const s = m.trim();
  return /^(よろしく|お願い|おねがい|続き|つづき|詳しく|詳細|もう少し|もうちょい|再度|教えて|教えてください|お願いします|お願いできますか|よろしくお願いします|よろしこ|よろ)$/.test(
    s
  );
}

function isInFollowupPhase(prevAssistantMessage: string | null): boolean {
  const s = (prevAssistantMessage ?? "");
  return s.includes("🍚攻め") && s.includes("🧂守り");
}

function isLineRequest(message: string): boolean {
  const m = (message ?? "").trim();
  return /(攻め|守り|攻守|上限|限界|どこまで|ギリ|グレー|危険|安全ライン|レンジ|幅|アウト|セーフ|リスク|大丈夫|いくら|いくつまで|なんぼ|どんぐらい)/.test(
    m
  );
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

function inferLens(message: string): Lens {
  const m = (message ?? "").trim();

  const hasMoney =
    /([0-9０-９]+)\s*(円|万円|万|千円)|¥\s*[0-9０-９]+|金額|上限|限度|相場|単価|目安|程度|レンジ|幅|ライン|いくら|いくらぐらい|どれぐらい|どれくらい|どのくらい|なんぼ|どんぐらい|くらい/.test(
      m
    );

  if (hasMoney) return "amount";

  // 「書類」単体では system に倒さない（有料価値が落ちるため）
  // ただし「書類＋制度操作語」のセットは system
  if (
    /(書類|資料)/.test(m) &&
    /(届出|規程|規定|手続|要件|インボイス|請求書|契約書|帳簿|仕訳)/.test(m)
  ) {
    return "system";
  }

  if (/(インボイス|消費税|控除|届出|規程|規定|ルール|手続|要件|仕訳|帳簿|請求書|契約書)/.test(m)) {
    return "system";
  }

  return "substance";
}

async function retrieveKnowledgeLines(params: {
  db: any;
  topic: string;
  lens: Lens;
}): Promise<{ attack: KnowledgeLine | null; defense: KnowledgeLine | null }> {
  const { db, topic, lens } = params;

  const run = async (withRole: boolean) => {
    let q = db
      .from("knowledge_lines")
      .select("id, topic, stance, lens, role, text, priority")
      .eq("is_active", true)
      .eq("topic", topic)
      .eq("lens", lens)
      .in("stance", ["attack", "defense"])
      .order("priority", { ascending: false })
      .limit(10);

    if (withRole) q = q.eq("role", "user");
    return q;
  };

  // role列がまだ無い環境でも落ちない保険（移行中のため）
  let data: any[] | null = null;
  let error: any = null;

  {
    const res = await run(true);
    const r = await res;
    data = r?.data ?? null;
    error = r?.error ?? null;

    const msg = String(error?.message ?? "");
    const missingRole = /role/i.test(msg) && /(column|does not exist|unknown)/i.test(msg);

    if (error && missingRole) {
      const res2 = await run(false);
      const r2 = await res2;
      data = r2?.data ?? null;
      error = r2?.error ?? null;
    }
  }

  if (error || !data) return { attack: null, defense: null };

  const rows = data as KnowledgeLine[];
  const attack = rows.find((r) => r.stance === "attack") ?? null;
  const defense = rows.find((r) => r.stance === "defense") ?? null;
  return { attack, defense };
}

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

function wantsAttackDefenseDetail(message: string, prevUserMessage: string | null): boolean {
  const m = (message ?? "").trim();
  const prev = (prevUserMessage ?? "").trim();

  const strong = /攻め|守り|攻守|上限|限界|どこまで|ギリ|グレー|危険|安全ライン|幅|レンジ|強め|弱め|リスク高|リスク低/.test(m);
  if (strong) return true;

  const followupCue =
    /(教えて|おしえて|詳しく|詳細|具体|もう少し|もっと|続き|つづき|お願い|おねがい|頼む|たのむ|よろしく|再度|もう一回|もういちど|さっき|今の|それ|よろしこ)/.test(
      m
    );

  const followupSolo = /^(よろ|よろです|よろです！|よろ！|よろー)$/.test(m);

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

  if (followupCue || followupSolo) return true;
  if (veryShort && !topicShiftLikely) return true;

  return false;
}

// ==== topic推定（リリース版）====

type TopicSpec = {
  topic: string;
  patterns: Array<{ re: RegExp; score: number }>;
};

// スコア上位が先頭になる（followup時に topics[0] を使うため）
const TOPIC_SPECS: TopicSpec[] = [
  // ===== 交際費（商品券も含む）=====
  {
    topic: "交際費",
    patterns: [
      { re: /(交際費|接待|会食|会合|同伴|手土産|お土産|贈答|贈答品|中元|お中元|歳暮|お歳暮|慶弔|香典|祝儀|ゴルフ)/, score: 10 },
      { re: /(商品券|ギフト券|ギフトカード|クオカード|QUOカード|図書カード|ビール券|プリペイド|商品券配布)/i, score: 9 },
      { re: /(飲食|飲み会|飲み|食事|会議費)/, score: 3 },
    ],
  },

  // ===== 出張手当（※文字クラス禁止！）=====
  {
    topic: "出張手当",
    patterns: [
      { re: /(出張手当|出張旅費|旅費交通費|旅費規程|旅費規定|日当|宿泊費|宿泊|ホテル|出張|交通費|新幹線|航空券|タクシー)/, score: 10 },
      { re: /(規程|規定|精算|実費|領収|立替)/, score: 3 },
    ],
  },

  // ===== 福利厚生 =====
  {
    topic: "福利厚生",
    patterns: [
      { re: /(福利厚生|懇親会|慰労会|社員旅行|社内イベント|レクリエーション|部活動|サークル|食事補助|ランチ補助|健康診断|予防接種)/, score: 10 },
      { re: /(社員(飲み会|飲み|懇親)|社内飲み|チーム飲み)/, score: 8 },
    ],
  },

  // ===== 外注 =====
  {
    topic: "外注",
    patterns: [
      { re: /(外注|外部委託|業務委託|委託|請負|準委任|委託料|業務委託費|フリーランス|個人事業主(の)?(委託|請負)|偽装(委託|請負))/i, score: 10 },
      { re: /(指揮命令|拘束|常駐|出社|タイムカード|勤怠|勤務時間|成果物|納品|検収|請求書|契約書)/, score: 4 },
    ],
  },

  // ===== 家事按分 =====
  {
    topic: "家事按分",
    patterns: [
      { re: /(家事按分|按分|自宅事務所|在宅|テレワーク)/, score: 10 },
      { re: /(家賃|光熱費|電気代|ガス代|水道代|通信費|ネット|インターネット|携帯|スマホ|固定電話)/, score: 6 },
    ],
  },

  // ===== 役員報酬 =====
  {
    topic: "役員報酬",
    patterns: [
      { re: /(役員報酬|役員給与|役員賞与|定期同額|事前確定賞与|取締役|役員|議事録)/, score: 10 },
      { re: /(期中(変更|改定|減額|増額)|報酬改定|届出)/, score: 6 },
    ],
  },

  // ===== 車両 =====
  {
    topic: "車両",
    patterns: [
      { re: /(外車|スポーツカー|輸入車|ベンツ|BMW|ポルシェ|フェラーリ|ランボルギーニ)/, score: 6 },
      { re: /(私用|家族利用|通勤)/, score: 4 },
    ],
  },

  // ===== 消費税 =====
  {
    topic: "消費税",
    patterns: [
      { re: /(消費税|インボイス|適格請求書|仕入税額控除|簡易課税|本則|課税事業者|免税事業者|2割特例|届出)/, score: 10 },
      { re: /(控除|課税売上|課税仕入|納税)/, score: 4 },
    ],
  },

  // ===== 税務調査 =====
  {
    topic: "税務調査",
    patterns: [
      { re: /(税務調査|国税|税務署|調査官|反面調査|質問検査権|調査)/, score: 10 },
      { re: /(資料(全部|提出|要求)|提出リスト|雑談|高圧|同業他社)/, score: 6 },
    ],
  },

  // ===== 退職金 =====
  {
    topic: "退職金",
    patterns: [
      { re: /(退職金|退職慰労金|分掌変更|退任|引退|相談役|会長|功績倍率|勤続年数)/, score: 10 },
    ],
  },

  // ===== 不動産 =====
  {
    topic: "不動産",
    patterns: [
      { re: /(不動産|物件|土地|建物|マンション|アパート|賃貸|購入|売却|減価償却|路線価|評価)/, score: 10 },
      { re: /(資産管理会社|節税不動産|借入)/, score: 4 },
    ],
  },

  // ===== 相続・承継 =====
  {
    topic: "相続・承継",
    patterns: [
      { re: /(相続|贈与|事業承継|承継|相続税|贈与税|遺言|遺産|遺留分|自社株|株価|後継者|家族会議)/, score: 10 },
    ],
  },

  // ===== ラク・管理 =====
  {
    topic: "ラク・管理",
    patterns: [
      { re: /(横領|不正|内部統制|チェック|承認|振込|権限|丸投げ|仕組み化|ルール化|自動化)/, score: 10 },
    ],
  },

  // ===== 個人資産 =====
  {
    topic: "個人資産",
    patterns: [
      { re: /(手取り|資産形成|投資|運用|株|インデックス|積立|NISA|iDeCo|譲渡|配当)/i, score: 10 },
    ],
  },

  // ===== 会社成長 =====
  {
    topic: "会社成長",
    patterns: [
      { re: /(成長|拡大|投資|採用|出店|多店舗|固定費|回収|スケール|借入|資金繰り)/, score: 10 },
    ],
  },

  // （育成カード側にある将来トピック：先に入れておく。DB未投入でも害なし）
  {
    topic: "家族給与・家族役員",
    patterns: [
      { 
  re: /(家族給与|家族に給与|家族役員|専従者|奥さん|嫁|妻|夫|家内|子ども|子供|こども|息子|娘|長男|長女|親|父|母|親戚|親族|パート|アルバイト)/,score: 10 },
    ],
  },
  {
    topic: "M&A",
    patterns: [
      { re: /(M&A|会社売却|株式譲渡|譲渡益|デューデリ|DD|買い手|売り手|バリュエーション)/i, score: 10 },
    ],
  },
];

function inferTopics(message: string, opts?: { max?: number }): string[] {
  const m = (message ?? "").trim();
  if (!m) return [];

  const familyRe = /(奥さん|嫁|妻|夫|家内|子ども|子供|こども|息子|娘|長男|長女|親|父|母|親戚|親族)/i;
  const payRe = /(給料|給与|報酬|賃金|人件費|手当|払|支払|振込)/i;

  const forced: string[] = [];
  if (familyRe.test(m) && payRe.test(m)) {
    forced.push("家族給与・家族役員");
  }

  const max = Math.max(1, Math.min(6, opts?.max ?? 3));

  const scored = TOPIC_SPECS.map((spec) => {
    let score = 0;
    for (const p of spec.patterns) {
      if (p.re.test(m)) score += p.score;
    }
    return { topic: spec.topic, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const topics = scored.slice(0, max).map((x) => x.topic);
  return [...new Set([...forced, ...topics])];
}

function inferTopicFromHistory(prevUserMessage: string | null, prevAssistantMessage: string | null): string | null {
  const u = prevUserMessage ? inferTopics(prevUserMessage, { max: 1 })[0] : null;
  if (u) return u;
  const a = prevAssistantMessage ? inferTopics(prevAssistantMessage, { max: 1 })[0] : null;
  if (a) return a;
  return null;
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

    if (it.amounts && Object.keys(it.amounts).length > 0) {
      lines.push(`- 目安金額: ${JSON.stringify(it.amounts)}`);
    }
  }
  return lines.join("\n");
}

type AttackDefensePick = {
  attack: string;
  defense: string;
  pitfall?: string | null;
};

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

function buildFollowupAnswerFromKb(items: KnowledgeItem[]): string | null {
  for (const it of items ?? []) {
    const ad = extractAttackDefenseFromContent(it.content);
    if (!ad) continue;

    const lines: string[] = [];
    lines.push(`🍚攻め：${ad.attack}`);
    lines.push(`🧂守り：${ad.defense}`);
    if (ad.pitfall) lines.push(`⚠️地雷メモ：${ad.pitfall}`);

    return lines.join("\n").trim();
  }
  return null;
}

function buildFollowupAnswerFromLines(params: { attack: KnowledgeLine | null; defense: KnowledgeLine | null }): string | null {
  const { attack, defense } = params;
  if (!attack || !defense) return null;

  const lines: string[] = [];
  lines.push(`🍚攻め：${attack.text}`);
  lines.push(`🧂守り：${defense.text}`);
  return lines.join("\n").trim();
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

async function retrieveKnowledge(params: { db: any; message: string }): Promise<KnowledgeItem[]> {
  const { db, message } = params;

  const topics = inferTopics(message, { max: 3 });
  if (topics.length === 0) return [];

  const { data, error } = await db
    .from("knowledge_items")
    .select("id, kind, topic, title, content, amounts, conditions, priority")
    .eq("is_active", true)
    .in("topic", topics)
    .order("priority", { ascending: false })
    .limit(8);

  if (error) return [];
  return (data ?? []) as KnowledgeItem[];
}

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

function hasAttackOrDefense(answer: string): boolean {
  const hasAttack = answer.includes("🍚");
  const hasDefense = answer.includes("🧂守り") || answer.includes("🧂🥄") || answer.includes("🧂 守り");
  return hasAttack || hasDefense;
}

function extractSection(answer: string, head: "🧂" | "✅" | "⚠️" | "🔎"): string[] {
  const lines = answer.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inSec = false;

  const markers = ["🧂", "✅", "⚠️", "🔎", "🍚"];

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

function ensureSaltBold(secSalt: string[]): string[] {
  if (secSalt.length === 0) return secSalt;
  const out = [...secSalt];

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

  if (!rest) {
    return ["🔎確認 税務・経営前提で答えた。前提が違うなら言うてな。"];
  }
  return [`${head} ${rest}`.trim()];
}

function enforceTemplate(answer: string): string {
  const a = answer.replace(/\r\n/g, "\n").trim();
  if (!a) return a;

  if (hasAttackOrDefense(a)) return a;

  const salt = ensureSaltBold(extractSection(a, "🧂"));
  const key = extractSection(a, "✅");
  const warn = extractSection(a, "⚠️");
  const ask = extractSection(a, "🔎");

  if (salt.length === 0 || key.length === 0) return a;

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
  parts.push(...salt, "");
  parts.push(...key);

  if (warn.length > 0) parts.push("", ...warn);
  if (askFixed.length > 0) parts.push("", ...collapseInquiryToSingleLine(askFixed));
  return parts.join("\n").trim();
}

function catchphraseFor(dialect: Dialect, stance: Stance): string {
  if (dialect === "kansai" && stance === "sanbo") {
    return "せやけど、税務の世界は答えひとつちゃいますさかい、🍚**攻めライン・🧂守り**ラインもお伝えできますさかい、遠慮なく言うてくださいな。";
  }
  if (dialect === "standard" && stance === "sanbo") {
    return "とはいえ、税務の世界は答えが一つではありませんので、🍚**攻めライン・🧂守り**の考え方も含めてお伝えできます。必要でしたらお知らせください。";
  }
  if (dialect === "kansai" && stance === "zubatto") {
    return "とはいえ、税務の世界は答えがひとつちゃう。🍚**攻めライン・🧂守り**ラインも知りたかったら、遠慮なく言うてな。";
  }
  return "とはいえ、税務の世界は答えが一つじゃない。🍚**攻めライン・🧂守り**ラインも知りたければ、遠慮なく言って。";
}

function forceCasual(text: string, dialect: Dialect): string {
  let s = (text ?? "").replace(/\r\n/g, "\n");

  s = s
    .replace(/ではありません/g, "ちゃう")
    .replace(/ではない/g, "ちゃう")
    .replace(/ありません/g, "ない")
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
  if (dialect === "standard" && stance === "sanbo")
    return "🔎確認 税務・経営前提で回答しました。前提が違う場合はお知らせください。";
  if (dialect === "standard" && stance === "zubatto")
    return "🔎確認 税務・経営前提で答えた。前提が違うなら言って。";
  if (dialect === "kansai" && stance === "sanbo")
    return "🔎確認 税務・経営前提でお答えしましたで。前提が違うなら言うてくださいな。";
  return "🔎確認 税務・経営前提で答えたで。前提が違うなら言うてな。";
}

function stripInternalLeaks(text: string): string {
  let s = String(text ?? "").replace(/\r\n/g, "\n");

  // まず括弧内の internal を削る
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

  // 空になったら最小の保険（破綻防止）
  if (!s) s = "🧂ちょうど良いライン：**一般論で整理する**。必要なら条件を揃えて深掘りする。";
  return s;
}

function postProcessAnswer(
  raw: string,
  dialect: Dialect,
  stance: Stance,
  opts: { usedKnowledge: boolean; allowAttackDefenseDetail: boolean; inquiryOverride?: string | null }
): string {
  const { usedKnowledge, allowAttackDefenseDetail } = opts;

  let a = String(raw ?? "").replace(/\r\n/g, "\n").trim();

  a = a.replace(/[\(（]最大[^)）]*[\)）]/g, "");

  {
  const override = (opts.inquiryOverride ?? "").trim();
  const lines = a.split("\n");
  const out: string[] = [];
  let replaced = false;

  for (const line of lines) {
    const t = line.trimStart();
    if (!t.startsWith("🔎")) {
      out.push(line);
      continue;
    }
    out.push(override ? override : inquiryLine(dialect, stance));
    replaced = true;
  }

  // 🔎が元の回答に無い時でも、overrideがあれば末尾に1行だけ足す
  if (!replaced && override) out.push(override);

  a = out.join("\n").trim();
}

  if (hasThreePatterns(a)) {
    const lines = a.split("\n");
    const out = lines.filter((line) => !isCatchphraseLine(line));
    a = out.join("\n").trim();
    return stripInternalLeaks(a);
  }

  a = enforceTemplate(a);

  if (!allowAttackDefenseDetail) {
    const lines2 = a.split("\n");
    const out: string[] = [];
    for (const line of lines2) {
      const t = line.trimStart();
      if (t.startsWith("🍚攻め") || t.startsWith("🧂守り")) continue;
      out.push(line);
    }
    a = out.join("\n").trim();
  } else {
    const lines2 = a.split("\n");
    const out = lines2.filter((line) => !line.trimStart().startsWith("🥄"));
    a = out.join("\n").trim();
  }

  const lines = a.split("\n");
  const already = lines.some((line) => isCatchphraseLine(line));
  if (usedKnowledge && !allowAttackDefenseDetail && !already) {
    a = `${a}\n\n${catchphraseFor(dialect, stance)}`.trim();
  }

  {
    const lines = a.split("\n");
    a = lines
      .map((line) => {
        if (!line.trimStart().startsWith("🔎")) return line;
        return line.replace(/[（(]\s*はい\s*\/\s*いいえ\s*[)）]/g, "").trimEnd();
      })
      .join("\n")
      .trim();
  }

  {
    const lines = a.split("\n");
    const out: string[] = [];
    for (const line of lines) {
      const t = line.trimStart();
      if (!t.startsWith("🔎")) {
        out.push(line);
        continue;
      }
      out.push(inquiryLine(dialect, stance));
    }
    a = out.join("\n").trim();
  }

  if (stance === "zubatto") a = forceCasual(a, dialect);

  {
    const lines2 = a.split("\n");
    const askLines = lines2.filter((l) => l.trimStart().startsWith("🔎"));
    if (askLines.length > 0) {
      const rest = lines2.filter((l) => !l.trimStart().startsWith("🔎"));
      a = [...rest, askLines[0]].join("\n").trim();
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
});

    if (!forbidden) return last;

    lastHits = findForbiddenHits(last, forbidden);
    if (lastHits.length === 0) return last;
  }

  if (stance === "zubatto") return forceCasual(last, dialect);
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
  const prevUserMessage = await (async () => {
    const { data: prevRows } = await db
      .from("messages")
      .select("content")
      .eq("conversation_id", convId)
      .eq("role", "user")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(2);

    return prevRows?.[1]?.content ?? prevRows?.[0]?.content ?? null;
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

  const followupExplicit = wantsAttackDefenseDetail(message, prevUserMessage);
  const followupPhase = isInFollowupPhase(prevAssistantMessage);
  const lineRequest = isLineRequest(message);
  const shifted = topicShiftLikelyLite(prevUserMessage, message);

  const followup = followupExplicit || lineRequest || (followupPhase && !shifted);
  const forceNormalAnswer = followupPhase && !followupExplicit && !lineRequest;

  const globalRules = await retrieveGlobalRules({ db });

  // ★ ここから topic/lens の確定と、経路ログ用の変数
  const topicsNow = inferTopics(message, { max: 3 });

  // lens は followup/normal 共通で使うので先に確定
  const lens: Lens = inferLens(isFollowupOnlyText(message) && prevUserMessage ? prevUserMessage : message);

  let topicKbItems = await retrieveKnowledge({ db, message });

  // followupでも、今メッセージでtopicが取れてるなら「前のtopic借り」はしない。
  // 借りるのは「よろ」「続き」「もう少し」みたいな短文追撃だけに限定。
  const shouldBorrowPrevTopic =
    followup &&
    topicKbItems.length === 0 &&
    topicsNow.length === 0 &&
    !shifted &&
    Boolean(prevUserMessage) &&
    (isFollowupOnlyText(message) || message.trim().length <= 6);

  if (shouldBorrowPrevTopic && prevUserMessage) {
    topicKbItems = await retrieveKnowledge({ db, message: prevUserMessage });
  }

  // ★ デバッグ用の経路トラッキング
  let usedLinesPick = false;
  let path: DebugTrace["path"] = "normal_llm";

  // followup経路で使う topic（ログにも使う）
  const inferredTopicForFollowup =
    topicsNow[0] ??
    (!shifted ? inferTopicFromHistory(prevUserMessage, prevAssistantMessage) : null) ??
    (topicKbItems?.[0]?.topic ?? null) ??
    "";

  if (followup && !forceNormalAnswer) {
    const header = "判断の軸だけ整理するで。";
    const footer = "※ 税務調査は「形式より実態」「一貫性」を見られる。";

    const topic = inferredTopicForFollowup;

    if (topic) {
      let built: string | null = null;

      const picked = await retrieveKnowledgeLines({ db, topic, lens });
      built = buildFollowupAnswerFromLines(picked);
      if (built) {
        usedLinesPick = true;
        path = "followup_lines";
      }

      if (!built) {
        built = buildFollowupAnswerFromKb(topicKbItems);
        if (built) path = "followup_kb";
      }

      if (!built) {
        const fb = fallbackAttackDefense(topic, lens);
        built = `🍚攻め：${fb.attack}\n🧂守り：${fb.defense}`.trim();
        path = "followup_fallback";
      }

      answer = `${header}\n\n${built}\n\n${footer}`.trim();
    }
  }

  // B) topic未確定の時だけ、🔎を「topic確認」に差し替える（YES/NOでは聞かない）
const needTopicClarify = topicsNow.length === 0 && topicKbItems.length === 0;

const inquiryOverride = needTopicClarify
  ? "🔎確認 どの話の相談かだけ教えて（例：交際費/出張手当/外注/家事按分/福利厚生/役員報酬/車両/消費税/税務調査/退職金/不動産/相続・承継）。"
  : null;

  if (!answer) {
  const usedKnowledge = topicKbItems.length > 0;
  const allowAttackDefenseDetail = followup;

  const kbGlobalBlock = formatKnowledgeBlock(globalRules);
  const kbTopicBlock = formatKnowledgeBlock(topicKbItems);

  const outputRules = buildOutputRules({ allowAttackDefenseDetail });
  const ambiguityBoost = buildAmbiguityBoostRules(message);
  const styleRules = buildStyleRules(dialect, stance);
  const contextLines = await buildConversationContext({ db, convId });

  // ✅ C) systemでも実態バイアス（ここでlensが見える）
  const systemBias =
    lens === "system"
      ? [
          "重要：制度（規程/届出/要件）の説明だけで終わらず、最初に『実態の地雷（運用のズレ）』を1つ提示してから制度の話に入る。ネットの一般論の羅列は禁止。",
        ]
      : [];

  const promptPartsBase: PromptParts = {
    context: contextLines,
    injectedRules: [
      ...outputRules,
      ...systemBias,        // ←ここに入れる
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
    allowAttackDefenseDetail,
    inquiryOverride, // Bで作ったやつ（ある場合）
  });

  path = "normal_llm";
}


  // ✅ 最終安全弁（どの経路でも internal 語彙を落とす）
  answer = stripInternalLeaks(answer);

  // ✅ topic推定結果をログに吐く（Vercel Logs + DB）
{
  const trace: DebugTrace = {
    convId,
    userId: user.id,
    messageHead: dbgHead(message, 120),
    topicsNow,
    inferredTopic: inferredTopicForFollowup || "",
    lens,
    followupExplicit,
    followupPhase,
    lineRequest,
    shifted,
    followup,
    forceNormalAnswer,
    usedKnowledge: topicKbItems.length > 0,
    usedLinesPick,
    path,
  };

  emitDebug(trace);                 // Vercel Logs
  await writeDebugEvent({ db, trace }); // DB保存
}
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
