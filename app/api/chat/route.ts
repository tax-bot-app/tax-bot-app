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

function buildOutputRules(params: {
  allowAttackDefenseDetail: boolean;
}): string[] {
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

  // 「安全度」系の曖昧語をトリガーにする
  const hasSafety =
    /安全度|安全性|リスク|危険|グレー|大丈夫/.test(m);

  if (!hasSafety) return [];

  return [
    "重要：ユーザーの『安全度/安全性/大丈夫？/リスク』は、まず税務・経営の安全性として解釈する（否認リスク/税務調査リスク/資金繰り・意思決定リスク）。一般的な安全（健康/事故/防犯）に逸れない。",
    "『安全度』は必ず『税務上の安全度（否認リスク/税務調査リスク）』として 高/中/低 の3段階で返す。",
    hasTaxWords
  ? "ユーザー文面が税務寄りなら、🔎は原則出さない（トーク消費を避ける）。"
  : "一般論の可能性が残る時だけ、末尾の🔎は『税務前提で答えた。前提が違うなら言って』の1行メモにする（YES/NOで聞かない）。",

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
  // ズバっとは常にタメ口（標準語でも関西弁でも）
  if (stance === "zubatto") return FORBIDDEN_POLITE;

  // 参謀：
  // - 標準語：丁寧OK（禁止なし）
  // - 関西弁：関西の丁寧語（〜です/〜ます）も“許可”する（禁止なし）
  return null;
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
        rules.push("文章は短文中心。1文は40文字以内を目安にする。");
    rules.push("箇条書きは最大3行まで。理由は2行以内にまとめる。");
    rules.push("言いにくいこともハッキリ言う（断定できない所は断定しない）。");
  } else {
    rules.push("人格は参謀。論点整理→選択肢→おすすめ→次のアクションで導く。");
    rules.push("情報が足りない所は、結論を急がず条件分岐で整理する。");
  }

  // 方言（語彙・語尾）
if (dialect === "kansai") {
  if (stance === "sanbo") {
    rules.push("関西弁の参謀は“丁寧な関西弁”で統一する（例：〜でっせ／〜でっしゃろ／〜ですわ／〜してはります／〜しときなはれ／〜してもろて）。タメ口（や/で/やな/やろ/ちゃう）は極力使わない。");
    rules.push("標準語の敬語（〜です/〜ますの“標準語文体”）は禁止。丁寧語を使う場合も関西の言い回しで統一する。");
rules.push("丁寧語・謙譲語を積極的に使う：〜です／〜ます／〜まっせ／〜でございます（多用はせん）／恐れ入りますが／〜いただけますか／〜してもろてもよろしいですか。");
rules.push("文末の7割以上を丁寧語で終える。『や・で』で終えるのは禁止に近い（例外はツッコミ1回まで）。");
  } else {
    rules.push("語彙・語尾は関西弁の口語。丁寧語（です/ます）は禁止。");
  }
  if (stance === "sanbo") {
  rules.push("語尾例：〜でっせ／〜でっしゃろ／〜ですわ／〜してはります／〜しときなはれ／〜してもろて／恐れ入りますが〜");
} else {
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
type MsgMini = { id: string; role: "user" | "assistant"; content: string; created_at: string };

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

  // 1) 直球ワード（今まで通り：強トリガー）
  const strong =
    /攻め|守り|攻守|上限|限界|どこまで|ギリ|グレー|危険|安全ライン|幅|レンジ|強め|弱め|リスク高|リスク低/.test(m);

  if (strong) return true;

  // 2) 「追撃っぽい短文」＝深掘り合図（取りこぼし防止）
  // 完全一致じゃなく「含む」で拾う（お願い/頼む/続き/もっと/詳しく/教えて など）
  const followupCue =
    /(教えて|おしえて|詳しく|詳細|具体|もう少し|もっと|続き|つづき|お願い|おねがい|頼む|たのむ|よろしく|再度|もう一回|もういちど|さっき|今の|それ)/.test(m);

  // 3) 「誤送信っぽい」も救う（短すぎる）
  const veryShort = m.length <= 2 || /^[\.\-ー…\?？!！wｗ]+$/.test(m);

  // 4) 明らかな話題転換なら止める（雑でOK・最小ガード）
  // 直前のユーザー発言がある場合だけ、キーワードが全く被ってないなら「別話題っぽい」
  const topicShiftLikely = (() => {
    if (!prev) return false;
    // ざっくり単語の被りを見たいので、漢字かな英数を3文字以上で拾う
    const tokens = (s: string) =>
      Array.from(s.matchAll(/[一-龠ぁ-んァ-ンA-Za-z0-9]{3,}/g)).map((x) => x[0]);
    const a = tokens(prev);
    const b = tokens(m);
    if (a.length === 0 || b.length === 0) return false;
    const setA = new Set(a);
    const overlap = b.some((t) => setA.has(t));
    return !overlap;
  })();

  // 追撃短文は“救済優先”で必ず深掘りON（話題転換チェックは無視）
if (followupCue) return true;

// 誤送信っぽい超短文は、話題転換っぽいならOFF（保険）
if (veryShort && !topicShiftLikely) return true;

  return false;
}

function inferTopics(message: string): string[] {
  const m = (message ?? "").trim();
  const topics: string[] = [];

  // 出張手当
  if (/[出張旅費日当手当宿泊]/.test(m)) topics.push("出張手当");

  // 交際費（接待・飲食・お土産・手土産・会食）
  if (/(交際費|接待|会食|飲み|飲食|飲み会|会合|手土産|お土産|贈答)/.test(m)) topics.push("交際費");

  return Array.from(new Set(topics));
}

function formatKnowledgeBlock(items: KnowledgeItem[]): string {
  if (!items || items.length === 0) return "";

  const lines: string[] = [];
  lines.push("【育成知見（最優先）】");
  lines.push("※一般論より優先して扱う。金額の目安は育成知見を採用する。");

  for (const it of items) {
    const tag = it.kind === "rule" ? "[Rule]" : it.kind === "qa" ? "[Q&A]" : "[Example]";
    lines.push(`${tag} ${it.title}`);
    // 文章（ニュアンス）をそのまま
    lines.push(`- ${it.content.replace(/\r\n/g, "\n").split("\n").join("\n- ")}`);

    // amountsがあれば“目安金額”があることを明示（中身は本文に書いてる想定）
    if (it.amounts && Object.keys(it.amounts).length > 0) {
      lines.push(`- 目安金額: ${JSON.stringify(it.amounts)}`);
    }
  }
  return lines.join("\n");
}

async function retrieveKnowledge(params: { db: any; message: string }): Promise<KnowledgeItem[]> {
  const { db, message } = params;

  const topics = inferTopics(message);

  // topicが取れたら topic一致で引く。取れなければ何もしない（最短）
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
      // 次のセクション開始で終了
      if (markers.some((m) => t.startsWith(m))) break;
      out.push(line.trimEnd());
    }
  }

  // 末尾の空行を落とす
  while (out.length > 0 && !out[out.length - 1].trim()) out.pop();
  return out;
}

function ensureSaltBold(secSalt: string[]): string[] {
  if (secSalt.length === 0) return secSalt;
  const out = [...secSalt];

  // すでに ** が含まれてるなら触らない
  if (out.some((l) => l.includes("**"))) return out;

  // パターン1：1行しかない（🧂行に結論が載ってる想定）
  if (out.length === 1) {
    const line = out[0];
    const idx = Math.max(line.indexOf("："), line.indexOf(":"));
    if (idx >= 0 && idx < line.length - 1) {
      const head = line.slice(0, idx + 1);
      const tail = line.slice(idx + 1).trim();
      if (tail) out[0] = `${head}**${tail}**`;
      return out;
    }
    // 仕方ないので行全体を太字（ダサいがルール未達よりマシ）
    out[0] = `**${line.trim()}**`;
    return out;
  }

  // パターン2：2行以上 → 2行目以降の最初の非空行を太字
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

  // 例：
  // ["🔎確認", "税務の安全度の話で合ってる？（はい/いいえ）"]
  // → ["🔎確認 税務の安全度の話で合ってる？（はい/いいえ）"]
  const head = askLines[0].trim();
  const rest = askLines
    .slice(1)
    .map((l) => l.trim())
    .filter((x) => x.length > 0)
    .join(" ");

  if (!rest) {
  // 🔎見出しだけ来た時の保険（空欄＝エラー感を消す）
  return ["🔎確認 税務前提で答えた。前提が違うなら言うてな。"];
}
  return [`${head} ${rest}`.trim()];
}

function enforceTemplate(answer: string): string {
  const a = answer.replace(/\r\n/g, "\n").trim();
  if (!a) return a;

  // 攻め/守りが絡む回答はテンプレ矯正しない（誤爆防止）
  if (hasAttackOrDefense(a)) return a;

  const salt = ensureSaltBold(extractSection(a, "🧂"));
  const key = extractSection(a, "✅");
  const warn = extractSection(a, "⚠️");
  const ask = extractSection(a, "🔎");

  // 🧂と✅が取れないなら、無理に再構築しない（内容消失が怖い）
  if (salt.length === 0 || key.length === 0) return a;

  // 🔎は最大1つ（先頭🔎ブロックのみ）
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
  // ① 関西弁 × 参謀（最優先）
  if (dialect === "kansai" && stance === "sanbo") {
    return "せやけど、税務の世界は答えひとつちゃいますさかい、🍚**攻めライン・🧂守り**ラインもお伝えできますさかい、遠慮なく言うてくださいな。";
  }

  // ② 標準語 × 参謀
  if (dialect === "standard" && stance === "sanbo") {
    return "とはいえ、税務の世界は答えが一つではありませんので、🍚**攻めライン・🧂守り**の考え方も含めてお伝えできます。必要でしたらお知らせください。";
  }

  // ③ 関西弁 × ズバっと
  if (dialect === "kansai" && stance === "zubatto") {
    return "とはいえ、税務の世界は答えがひとつちゃう。🍚**攻めライン・🧂守り**ラインも知りたかったら、遠慮なく言うてな。";
  }

  // ④ 標準語 × ズバっと
  return "とはいえ、税務の世界は答えが一つじゃない。🍚**攻めライン・🧂守り**ラインも知りたければ、遠慮なく言って。";
}

function forceCasual(text: string, dialect: Dialect): string {
  // 最終手段：敬語を機械的に潰して“タメ口”へ寄せる
  let s = (text ?? "").replace(/\r\n/g, "\n");

  // 強制置換（よく出るやつから）
  s = s
    .replace(/ではありません/g, "ちゃう")
    .replace(/ではない/g, "ちゃう")
    .replace(/ありません/g, "ない")
    .replace(/でした/g, dialect === "kansai" ? "やった" : "だった")
    .replace(/です/g, dialect === "kansai" ? "や" : "だ")
    .replace(/ます/g, "") // 「します」→「し」になり得るが、敬語混在よりマシ（ズバっと時のみ発動）
    .replace(/ください/g, dialect === "kansai" ? "して" : "して")
    .replace(/でしょう/g, dialect === "kansai" ? "やろ" : "だろ")
    .replace(/かもしれません/g, dialect === "kansai" ? "かもな" : "かもな");

  // 「します」等が崩れた時の最低限の整形（雑でOK、ズバっとは短い方が正義）
  s = s.replace(/し。/g, "する。").replace(/し\n/g, "する\n");

  return s;
}

function inquiryLine(dialect: Dialect, stance: Stance): string {
  if (dialect === "standard" && stance === "sanbo")
    return "🔎確認（返事いらんメモ） 税務前提で回答しました。前提が違う場合はお知らせください。";
  if (dialect === "standard" && stance === "zubatto")
    return "🔎確認（返事いらんメモ） 税務前提で答えた。前提が違うなら言って。";
  if (dialect === "kansai" && stance === "sanbo")
    return "🔎確認（返事いらんメモ） 税務前提でお答えしましたで。前提が違うなら言うてくださいな。";
  return "🔎確認（返事いらんメモ） 税務前提で答えたで。前提が違うなら言うてな。";
}

function postProcessAnswer(
  raw: string,
  dialect: Dialect,
  stance: Stance,
  opts: { usedKnowledge: boolean; allowAttackDefenseDetail: boolean }
): string {
  const { usedKnowledge, allowAttackDefenseDetail } = opts;

  let a = String(raw ?? "").replace(/\r\n/g, "\n").trim();

  // 余計な括弧メモを落とす（既存方針）
  a = a.replace(/[\(（]最大[^)）]*[\)）]/g, "");

  // 🔎複数対策（既存ロジック維持）
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

  // 3パターン時は決め台詞削除で終了（既存ロジック維持）
  if (hasThreePatterns(a)) {
    const lines = a.split("\n");
    const out = lines.filter((line) => !isCatchphraseLine(line));
    a = out.join("\n").trim();
    return a;
  }

  // ✅ ここでテンプレを矯正（※決め台詞を足す前）
  a = enforceTemplate(a);

  // ===== 30号店FIX =====
  // 初回（深掘りでない）では 🍚攻め/🧂守り を出さない
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
    // 深掘り時は 🥄ちょうど良いライン を出さない（繰り返し防止）
    const lines2 = a.split("\n");
    const out = lines2.filter((line) => !line.trimStart().startsWith("🥄"));
    a = out.join("\n").trim();
  }

  // 決め台詞：育成知見あり & 深掘りじゃない時だけ
  const lines = a.split("\n");
  const already = lines.some((line) => isCatchphraseLine(line));
  if (usedKnowledge && !allowAttackDefenseDetail && !already) {
    a = `${a}\n\n${catchphraseFor(dialect, stance)}`.trim();
  }

  // （はい/いいえ）系を消す（返事不要設計）
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

  // 🔎は「返事いらんメモ」に固定（質問調を潰す）
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

  // ズバっとは最終手段でタメ口寄せ（既存方針）
  if (stance === "zubatto") a = forceCasual(a, dialect);

  // 🔎がある場合は必ず末尾1行に寄せる（最終保険）
  {
    const lines2 = a.split("\n");
    const askLines = lines2.filter((l) => l.trimStart().startsWith("🔎"));
    if (askLines.length > 0) {
      const rest = lines2.filter((l) => !l.trimStart().startsWith("🔎"));
      a = [...rest, askLines[0]].join("\n").trim();
    }
  }

  a = a.replace(/^返事いらんメモ[:：].*$/gm, "").trim();

  return a;
}


async function generateAnswerStrict(params: {
  message: string;
  promptPartsBase: PromptParts;
  dialect: Dialect;
  stance: Stance;
  usedKnowledge: boolean;
  allowAttackDefenseDetail: boolean;
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
  // 直前のユーザー発言（同スレッド内）を最大2件取得（追撃救済に使う）
const prevUserMessage = await (async () => {
  const { data: prevRows } = await db
    .from("messages")
    .select("content")
    .eq("conversation_id", convId)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(2);

  // 0番目が“今の入力”になり得るので、1番目（ひとつ前）を優先
  return prevRows?.[1]?.content ?? prevRows?.[0]?.content ?? null;
})();

// 追撃（お願い/詳しく等）判定
const followup = wantsAttackDefenseDetail(message, prevUserMessage);

// A) 制度基準（常時注入：usedKnowledge判定には使わない）
const globalRules = await retrieveGlobalRules({ db });

// B) テーマ知見（QA等：深掘り判定の対象）
let topicKbItems = await retrieveKnowledge({ db, message });

// 追撃なのに知見が取れないなら、直前のユーザー発言で知見を取り直す（救済）
if (followup && topicKbItems.length === 0 && prevUserMessage) {
  topicKbItems = await retrieveKnowledge({ db, message: prevUserMessage });
}

const usedKnowledge = topicKbItems.length > 0;

// ✅ 詳細攻め守り：ユーザーが求めた時だけON（※topic知見がある場合のみ）
const allowAttackDefenseDetail = usedKnowledge && followup;

// 注入ブロック（制度基準 → テーマ知見 の順で入れる）
const kbGlobalBlock = formatKnowledgeBlock(globalRules);
const kbTopicBlock = formatKnowledgeBlock(topicKbItems);

  // 2) ルール類を組み立て
  const outputRules = buildOutputRules({
  allowAttackDefenseDetail,
});
  const ambiguityBoost = buildAmbiguityBoostRules(message);
  const styleRules = buildStyleRules(dialect, stance);
  const contextLines = await buildConversationContext({ db, convId });

  // 3) promptParts を作成（育成知見は injectedRules に追加）
  const promptPartsBase: PromptParts = {
    context: contextLines,
    injectedRules: [
  ...outputRules,
  ...ambiguityBoost,
  ...styleRules,
  ...(kbGlobalBlock ? [kbGlobalBlock] : []),
  ...(kbTopicBlock ? [kbTopicBlock] : []),
],
    guardrails: gr.action === "inject" ? gr.guardrailLines : [],
  };

  // 4) 生成（フラグも渡す）
  answer = await generateAnswerStrict({
  message,
  promptPartsBase,
  dialect,
  stance,
  usedKnowledge,
  allowAttackDefenseDetail,
});
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
