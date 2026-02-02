// app/lib2/topicDecision.ts
// 税務調査 sticky / overlay / axis-subject 決定 + lens補正

export type Lens = "amount" | "substance" | "system";

export const TOPIC_TAX_AUDIT = "税務調査";

// ===== 新規：紹介料 vs 外注の差し戻し用 =====
const TOPIC_REFERRAL = "紹介料"; // topicSignals 側の topic 名に合わせる
const TOPIC_OUTSOURCE = "外注";

function buildRecentText(message: string, recentUserMsgs: string[]): string {
  const tail = (recentUserMsgs ?? []).slice(-4).join("\n");
  return `${message ?? ""}\n${tail}`.trim();
}

// “純外注”の匂い：外注topicに戻したい
function looksPureOutsource(text: string): boolean {
  return (
    /(成果物|納品|検収|制作|デザイン|開発|コーディング|実装|原稿|記事|ライティング|編集|運用|保守|テスト|仕様|要件|工数|見積)/.test(
      text
    ) ||
    /(指揮命令|常駐|出社|勤怠|タイムカード|勤務時間|シフト|席|PC支給|社用メール|社内システム|上司|評価|業務指示)/.test(
      text
    ) ||
    /(偽装(委託|請負)|偽装請負|準委任|請負|派遣|労働者派遣)/.test(text)
  );
}

// “紹介料/口利き”の匂い：紹介料topicを維持したい
function looksReferral(text: string): boolean {
  return /(紹介|仲介|成功報酬|口利き|リファラル|マージン|コミッション|バック|キックバック|謝礼|協力費)/.test(
    text
  );
}

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
  "紹介料"
  // TOPIC_REFERRAL,
]);

// ===== 税務調査を「原則重ねたくない」topic =====
// 方針：経営/運用/設計の抽象話は、惰性stickyで auditAxis=true にしない（ただし明示税務調査/lineRequest/overlayなら例外）
export const AUDIT_STICKY_EXEMPT_TOPICS = new Set<string>([
  "会社成長",
  "個人資産",
  "ラク・管理",

  // 「節税・設計・投資」系の実体
  "余剰資金運用",
  "資金戦略",
  "資金移転",

  // 長期・抽象・経営判断寄り
  "M&A",
  "相続・承継",
]);


export function isExplicitTopicShiftPhrase(message: string): boolean {
  const m = (message ?? "").trim();
  return /(別件|話(を)?変え|話題(を)?変え|ところで|それはそうと|次の相談|別の相談|一旦置いといて)/.test(
    m
  );
}

export function isExplicitTaxAuditOff(message: string): boolean {
  const m = (message ?? "").trim();
  return /(調査は関係ない|税務調査は関係ない|税務調査じゃない|調査の話はもういい|調査はもういい|調査は一旦)/.test(
    m
  );
}

function hasTaxAuditWords(text: string): boolean {
  const t = (text ?? "").trim();
  return /(税務調査|調査官|国税|税務署|反面調査|更正|修正申告|過少申告|重加算|質問検査|任意調査|臨場|調査(対応|対策|で)|税務署(から|来)|国税(から|来))/i.test(
    t
  );
}

function looksLineRequest(text: string): boolean {
  const t = (text ?? "").trim();
  // 「どこまで」「大丈夫？」が amount に倒れるのを抑えたい → ここでは “lineRequest” としてsticky維持側に回す
  return /(安全ライン|どこまで|大丈夫|リスク|グレー|アウト|セーフ|上限|限界|ギリ|攻め|守り|攻守|詰められ|バレ|突っ込まれ|否認)/.test(
    t
  );
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
export function decideAxisSubject(
  input: DecideAxisSubjectInput
): DecideAxisSubjectOutput {
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

  const explicitTopicShift =
    explicitTopicShiftIn ?? isExplicitTopicShiftPhrase(message);
  const explicitTaxOff = explicitTaxOffIn ?? isExplicitTaxAuditOff(message);

  // subject候補：今→前（税務調査は除外）
  const subjectNow = topicsNow.find((t) => t !== TOPIC_TAX_AUDIT) ?? "";
  const subjectPrev = topicsPrev.find((t) => t !== TOPIC_TAX_AUDIT) ?? "";
  let subjectTopic = subjectNow || (continuationLike ? subjectPrev : "") || "";

  // --- 37.4+：紹介料 ⇄ 外注の差し戻し（“雑な業務委託費”問題の回収） ---
  // topicSignalsが「業務委託費」を紹介料寄せにしている前提で、
  // “純外注”っぽいときだけ外注へ戻す。
  if (subjectTopic === TOPIC_REFERRAL) {
    const text = buildRecentText(message, recentUserMsgs);
    // 紹介/仲介ワードが明確なら紹介料を維持
    if (!looksReferral(text) && looksPureOutsource(text)) {
      subjectTopic = TOPIC_OUTSOURCE;
    }
  }

    // tax audit 文脈が近いか（イベント型）
  const recentText = buildRecentText(message, recentUserMsgs);

  const hasAuditNow =
    topicsNow.includes(TOPIC_TAX_AUDIT) || hasTaxAuditWords(message);

  const hasAuditRecent =
    hasTaxAuditWords(recentText) || hasTaxAuditWords(prevAssistantMessage ?? "");

  const taxAuditContextActive =
    hasAuditNow ||
    topicsPrev.includes(TOPIC_TAX_AUDIT) ||
    hasAuditRecent;

  // overlay：主題が対象なら軸に税務調査を重ねる（ここは現行仕様）
  const overlayWanted =
    !explicitTaxOff &&
    Boolean(subjectTopic) &&
    AUDIT_OVERLAY_TOPICS.has(subjectTopic);

  // ★ sticky解除条件（リリース仕様：exempt topics は惰性で audit にしない）
  const lineRequest = looksLineRequest(message);
  const subjectIsExempt =
    Boolean(subjectTopic) && AUDIT_STICKY_EXEMPT_TOPICS.has(subjectTopic);

  const shouldUnstickForExempt =
    subjectIsExempt &&
    !hasTaxAuditWords(message) &&          // 今の発話に税務調査ワードなし
    !lineRequest &&                        // 安全ライン/詰められ系じゃない
    !overlayWanted &&                      // overlay でもない
    !topicsNow.includes(TOPIC_TAX_AUDIT);  // 今topicとして税務調査が立ってない

  // sticky：明示オフ/明示話題転換で解除 ＋ exempt topic のときも解除
  const taxAuditSticky =
    taxAuditContextActive &&
    !explicitTaxOff &&
    !explicitTopicShift &&
    !shouldUnstickForExempt;


  // auditAxis も boolean 確定
  const auditAxis =
    !explicitTaxOff &&
    (taxAuditSticky || topicsNow.includes(TOPIC_TAX_AUDIT) || overlayWanted);

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
 * lens補正
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
  const hasMoney =
    /([0-9０-９]+)\s*(円|万円|万|千円)|¥\s*[0-9０-９]+|金額|上限|限度|相場|単価|目安|程度|レンジ|幅|いくら|なんぼ/.test(
      m
    );

  const hasLineWords = /(上限|限界|ギリ|グレー|安全ライン|アウト|セーフ|攻め|守り|攻守)/.test(m);
  const hasScopeWords = /(どこまで|大丈夫|リスク|安全度|安全性)/.test(m);

  // system：制度/要件/帳簿・届出
  const isSystem =
    /(インボイス|消費税|控除|届出|規程|規定|ルール|手続|要件|仕訳|帳簿|請求書|契約書|稟議|承認)/.test(m) ||
    (/(書類|資料)/.test(m) && /(届出|規程|規定|要件|帳簿|契約書)/.test(m));

  // 税務調査：運用/対応の話は substance 寄り
  const isAuditOps = /(雑談|反面調査|高圧|態度|圧|雰囲気|資料(全部|提出|要求)|提出リスト|ヒアリング|質問|調査官|国税|税務署)/.test(
    m
  );

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
