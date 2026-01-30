// app/lib2/topicDecision.ts
// 税務調査 sticky / overlay / axis-subject 決定 + lens補正

export type Lens = "amount" | "substance" | "system";

export const TOPIC_TAX_AUDIT = "税務調査";

// 「この主題が出たら “税務調査軸” を自然に重ねる」対象
export const AUDIT_OVERLAY_TOPICS = new Set<string>([
  "交際費",
  "外注",
  "家事按分",
  "福利厚生",
  "出張手当",
  "役員報酬",
  "車両",
  "消費税",
  "家族給与・家族役員",
  "退職金",
]);

export function isExplicitTopicShiftPhrase(message: string): boolean {
  const m = (message ?? "").trim();
  return /(別件|話(を)?変え|話題(を)?変え|ところで|それはそうと|次の相談|別の相談|一旦置いといて)/.test(m);
}

export function isExplicitTaxAuditOff(message: string): boolean {
  const m = (message ?? "").trim();
  return /(調査は関係ない|税務調査は関係ない|税務調査じゃない|調査の話はもういい|調査はもういい|調査は一旦)/.test(m);
}

export type DecideAxisSubjectInput = {
  message: string;

  topicsNow: string[];
  topicsPrev: string[];

  prevAssistantMessage: string | null;
  recentUserMsgs: string[]; // 直近ユーザー発言（本文）

  continuationLike: boolean;

  explicitTopicShift?: boolean;
  explicitTaxOff?: boolean;
};

export type DecideAxisSubjectOutput = {
  axisTopic: string;
  subjectTopic: string;
  auditAxis: boolean;

  taxAuditSticky: boolean;
  reason: string;

  overlayWanted: boolean;
};

/**
 * ダブルトピック決定：
 * axis = 税務調査（sticky/overlay）
 * subject = 交際費/外注など（主題）
 */
export function decideAxisSubject(input: DecideAxisSubjectInput): DecideAxisSubjectOutput {
  const {
    message,
    topicsNow,
    topicsPrev,
    prevAssistantMessage,
    recentUserMsgs,
    continuationLike,
    explicitTopicShift: explicitTopicShiftIn,
    explicitTaxOff: explicitTaxOffIn,
  } = input;

  const explicitTopicShift = explicitTopicShiftIn ?? isExplicitTopicShiftPhrase(message);
  const explicitTaxOff = explicitTaxOffIn ?? isExplicitTaxAuditOff(message);

  // subject候補：今→前（税務調査は除外）
  const subjectNow = topicsNow.find((t) => t !== TOPIC_TAX_AUDIT) ?? "";
  const subjectPrev = topicsPrev.find((t) => t !== TOPIC_TAX_AUDIT) ?? "";
  const subjectTopic = subjectNow || (continuationLike ? subjectPrev : "") || "";

  // tax audit 文脈が近いか（イベント型）
  const taxAuditContextActive =
    topicsNow.includes(TOPIC_TAX_AUDIT) ||
    topicsPrev.includes(TOPIC_TAX_AUDIT) ||
    (prevAssistantMessage ?? "").includes(TOPIC_TAX_AUDIT) ||
    (recentUserMsgs ?? []).some((m) => (m ?? "").includes(TOPIC_TAX_AUDIT));

  // sticky：明示オフ/明示話題転換でだけ解除
  const taxAuditSticky = taxAuditContextActive && !explicitTaxOff && !explicitTopicShift;

  // overlay：主題が対象なら軸に税務調査を重ねる（追撃CTAしたい）
  // overlay：主題が対象なら軸に税務調査を重ねる（追撃CTAしたい）
const overlayWanted = !explicitTaxOff && Boolean(subjectTopic) && AUDIT_OVERLAY_TOPICS.has(subjectTopic);

// auditAxis も boolean 確定
const auditAxis = (!explicitTaxOff) && (taxAuditSticky || topicsNow.includes(TOPIC_TAX_AUDIT) || overlayWanted);

  // axisTopic：auditAxisなら税務調査、それ以外は topicsNow 先頭（無ければ空）
  const axisTopic = auditAxis ? TOPIC_TAX_AUDIT : (topicsNow[0] ?? "");

  let reason = "normal";
  if (explicitTaxOff) reason = "explicit_tax_audit_off";
  else if (explicitTopicShift) reason = "explicit_topic_shift";
  else if (topicsNow.includes(TOPIC_TAX_AUDIT)) reason = "message_mentions_tax_audit";
  else if (taxAuditSticky) reason = "sticky_tax_audit_context";
  else if (overlayWanted) reason = "overlay_by_subject";
  else reason = "no_audit_axis";

  return { axisTopic, subjectTopic, auditAxis, taxAuditSticky, reason, overlayWanted };
}

/**
 * lens補正（税務調査だけ）
 * - 「どこまで」「安全？」「大丈夫？」が amount に倒れすぎるのを抑制
 * - 税務調査は scope 系を substance/system に寄せる
 */
export function inferLensWithContext(params: {
  message: string;
  axisTopic: string;
  fallbackPrevUser?: string | null;
  usePrevInstead?: boolean; // 追撃短文等
}): Lens {
  const axis = params.axisTopic;
  const m0 = (params.usePrevInstead ? params.fallbackPrevUser : params.message) ?? params.message;
  const m = (m0 ?? "").trim();

  // amount優先：金額やレンジが明確
  const hasMoney = /([0-9０-９]+)\s*(円|万円|万|千円)|¥\s*[0-9０-９]+|金額|上限|限度|相場|単価|目安|程度|レンジ|幅|いくら|なんぼ/.test(m);

  const hasLineWords = /(上限|限界|ギリ|グレー|安全ライン|アウト|セーフ|攻め|守り|攻守)/.test(m);
  const hasScopeWords = /(どこまで|大丈夫|リスク|安全度|安全性)/.test(m);

  // system：制度/要件/帳簿・届出
  const isSystem =
    /(インボイス|消費税|控除|届出|規程|規定|ルール|手続|要件|仕訳|帳簿|請求書|契約書|稟議|承認)/.test(m) ||
    (/(書類|資料)/.test(m) && /(届出|規程|規定|要件|帳簿|契約書)/.test(m));

  // 税務調査：運用/対応の話は substance 寄り
  const isAuditOps = /(雑談|反面調査|高圧|態度|圧|雰囲気|資料(全部|提出|要求)|提出リスト|ヒアリング|質問|調査官|国税|税務署)/.test(m);

  if (axis === TOPIC_TAX_AUDIT) {
    // 金額が明確なら amount
    if (hasMoney) return "amount";

    // 調査での対応/運用は substance
    if (isAuditOps) return "substance";

    // scope系（どこまで/安全/リスク）は amount に倒さない
    if (hasScopeWords || hasLineWords) {
      return isSystem ? "system" : "substance";
    }

    // 制度寄りなら system、そうでなければ substance
    if (isSystem) return "system";
    return "substance";
  }

  // 通常時：金額が明確なら amount
if (hasMoney) return "amount";

// 「どこまで/安全/リスク」系は、金額が無いなら amount に倒さない
if (hasScopeWords || hasLineWords) {
  return isSystem ? "system" : "substance";
}

if (isSystem) return "system";
return "substance";
}
