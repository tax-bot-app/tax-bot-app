// app/lib2/topicDecision.ts
// 税務調査 sticky / overlay / axis-subject 決定 + lens補正

export type Lens = "amount" | "substance" | "system";

export const TOPIC_TAX_AUDIT = "税務調査";

// ===== 新規：紹介料 vs 外注の差し戻し用 =====
const TOPIC_REFERRAL = "紹介料";
const TOPIC_OUTSOURCE = "外注";

function buildRecentText(message: string, recentUserMsgs: string[]): string {
  const tail = (recentUserMsgs ?? []).slice(-4).join("\n");
  return `${message ?? ""}\n${tail}`.trim();
}

// “純外注”の匂い：外注topicに戻したい
function looksPureOutsource(text: string): boolean {
  return (
    /(成果物|納品|検収|制作|デザイン|開発|コーディング|実装|原稿|記事|ライティング|編集|運用|保守|テスト|仕様|要件|工数|見積)/.test(text) ||
    /(指揮命令|常駐|出社|勤怠|タイムカード|勤務時間|シフト|席|PC支給|社用メール|社内システム|上司|評価|業務指示)/.test(text) ||
    /(偽装(委託|請負)|偽装請負|準委任|請負|派遣|労働者派遣)/.test(text)
  );
}

// “紹介料/口利き”の匂い：紹介料topicを維持したい
function looksReferral(text: string): boolean {
  return /(紹介|仲介|成功報酬|口利き|リファラル|マージン|コミッション|バック|キックバック|謝礼|協力費)/.test(text);
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
  "紹介料",
]);

// ===== 税務調査を「原則重ねたくない」topic =====
export const AUDIT_STICKY_EXEMPT_TOPICS = new Set<string>([
  "会社成長",
  "個人資産",
  "ラク・管理",
  "余剰資金運用",
  "資金戦略",
  "資金移転",
  "M&A",
  "相続・承継",
]);

export function isExplicitTopicShiftPhrase(message: string): boolean {
  const m = (message ?? "").trim();
  return /(別件|話(を)?変え|話題(を)?変え|ところで|それはそうと|次の相談|別の相談|一旦置いといて)/.test(m);
}

export function isExplicitTaxAuditOff(message: string): boolean {
  const m = (message ?? "").trim();
  return /(調査は関係ない|税務調査は関係ない|税務調査じゃない|調査の話はもういい|調査はもういい|調査は一旦)/.test(m);
}

function hasTaxAuditWords(text: string): boolean {
  const t = (text ?? "").trim();
  return /(税務調査|調査官|国税|税務署|反面調査|更正|修正申告|過少申告|重加算|質問検査|任意調査|臨場|調査(対応|対策|で)|税務署(から|来)|国税(から|来))/i.test(
    t
  );
}

function looksLineRequest(text: string): boolean {
  const t = (text ?? "").trim();
  // NOTE: 「大丈夫」を入れると followup_lines 維持が強くなる。必要なら後で削る。
  return /(安全ライン|どこまで|安全度|安全性|リスク|グレー|アウト|セーフ|上限|限界|ギリ|攻め|守り|攻守|詰められ|バレ|突っ込まれ|否認)/.test(
  t
);

}

/**
 * ★重要：
 * "大丈夫" = 大 丈 夫 の「夫」で家族判定が暴発する。
 * → 今回の発話で“主題採用”する判定は Strong（夫を含めない）
 * → 文脈として残ってるかを見るのは Weak（夫を含めてもOK）
 */
function hasFamilyStrong(text: string): boolean {
  const t = (text ?? "").trim();
  // ★「夫」は入れない（大丈夫誤爆の根を断つ）
  return /(奥さん|嫁|妻|家内|子ども|子供|こども|息子|娘|長男|長女|親戚|親族|身内|家のもん|家の者|家族|専従者|家族給与|家族役員)/.test(
    t
  );
}

// ===== 消費税（免税）Strong =====
function hasConsumptionTaxStrong(text: string): boolean {
  const t = (text ?? "").trim();
  // ※ インバウンドは入れない（掛け算は後段で成立させる）
  return /(免税売上|免税|非課税売上|課税売上|消費税)/.test(t);
}

function hasFamilyWeak(text: string): boolean {
  const t = (text ?? "").trim();
  // 文脈用：夫/父/母/親も含める
  return /(奥さん|嫁|妻|夫|家内|子ども|子供|こども|息子|娘|長男|長女|親|父|母|親戚|親族|身内|家のもん|家の者|家族|専従者|家族給与|家族役員)/.test(
    t
  );
}

function hasCashConcernNow(text: string): boolean {
  const t = (text ?? "").trim();
  return (
    /(手元資金|手元の現金|現金|キャッシュ|資金繰り|運転資金).*(大丈夫|足り|不足|不安|心配|回る|回らん|きつい|詰)/.test(t) ||
    /(大丈夫|足り|不足|不安|心配|回る|回らん|きつい|詰).*(手元資金|手元の現金|現金|キャッシュ|資金繰り|運転資金)/.test(t)
  );
}

function hasProfitAnxietyNow(text: string): boolean {
  const t = (text ?? "").trim();
  return /(利益|黒字|売上).*(不安|心配|安心でき|大丈夫)/.test(t) || /(不安|心配|安心でき|大丈夫).*(利益|黒字|売上)/.test(t);
}

function hasOpsPainNow(text: string): boolean {
  const t = (text ?? "").trim();
  return /(回らん|追いつか|パンク|忙しすぎ|時間ない|属人化|あの人おらん|誰が何|同じミス|バタバタ)/.test(t);
}

function hasFamilyContext(text: string): boolean {
  const t = (text ?? "").trim();
  // 文脈ゲート（夫も含めてOK）
  return /(奥さん|嫁|妻|夫|家内|子ども|子供|こども|息子|娘|長男|長女|親戚|親族|家族給与|家族役員|専従者|家族)/.test(t);
}

function hasCashConcern(text: string): boolean {
  const t = (text ?? "").trim();
  return (
    /(手元資金|手元の現金|現金|キャッシュ|資金繰り|運転資金).*(大丈夫|足り|不足|不安|心配|回る|回らん|きつい|詰)/.test(t) ||
    /(大丈夫|足り|不足|不安|心配|回る|回らん|きつい|詰).*(手元資金|手元の現金|現金|キャッシュ|資金繰り|運転資金)/.test(t)
  );
}

function hasOpsPain(text: string): boolean {
  const t = (text ?? "").trim();
  return /(回らん|追いつか|パンク|忙しすぎ|時間ない|属人化|あの人おらん|誰が何|同じミス|バタバタ)/.test(t);
}

export type DecideAxisSubjectInput = {
  message: string;

  topicsNow: string[];
  topicsPrev: string[];

  prevAssistantMessage: string | null;
  recentUserMsgs: string[];

  continuationLike: boolean;

  explicitTopicShift?: boolean;
  explicitTaxOff?: boolean;

  llmNudgeLines?: boolean;
llmNudgeReason?: string;

};

export type DecideAxisSubjectOutput = {
  axisTopic: string;
  subjectTopic: string;
  auditAxis: boolean;

  taxAuditSticky: boolean;
  reason: string;

  overlayWanted: boolean;
  nudgeLines?: boolean;
nudgeReason?: string;
};

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
  let subjectTopic = subjectNow || (continuationLike ? subjectPrev : "") || "";

  // --- 紹介料 ⇄ 外注 差し戻し ---
  if (subjectTopic === TOPIC_REFERRAL) {
    const text = buildRecentText(message, recentUserMsgs);
    if (!looksReferral(text) && looksPureOutsource(text)) {
      subjectTopic = TOPIC_OUTSOURCE;
    }
  }

    const recentText = buildRecentText(message, recentUserMsgs);

  // ===== 消費税：免税は Strong で主題確定 =====
  if (hasConsumptionTaxStrong(message)) {
    subjectTopic = "消費税";
  }
 

  // ===== 家族給与・家族役員：主題採用ルール（誤爆根絶） =====
  const familyInContext = hasFamilyWeak(recentText);
  const familyTriggerNow = hasFamilyStrong(message); // ★ここが肝（夫で暴発させない）
  const cashNow = hasCashConcernNow(message) || hasProfitAnxietyNow(message);
  const opsPainNow = hasOpsPainNow(message);

  if (subjectTopic === "家族給与・家族役員" && !familyTriggerNow) {
    if (cashNow) {
      subjectTopic = "会社成長";
    } else {
      const altNow = topicsNow.find((t) => t !== TOPIC_TAX_AUDIT && t !== "家族給与・家族役員") ?? "";
      const altPrev = topicsPrev.find((t) => t !== TOPIC_TAX_AUDIT && t !== "家族給与・家族役員") ?? "";

      subjectTopic = altNow || (continuationLike ? altPrev : "") || "";

      if (!subjectTopic) {
        if (opsPainNow) subjectTopic = "ラク・管理";
        else if (cashNow) subjectTopic = "会社成長";
      }
    }
  }

  // 妥当性ゲート：家族給与は文脈に家族が無いなら主題採用しない
  if (subjectTopic === "家族給与・家族役員" && !hasFamilyContext(recentText) && !familyInContext) {
    const altNow = topicsNow.find((t) => t !== TOPIC_TAX_AUDIT && t !== "家族給与・家族役員") ?? "";
    const altPrev = topicsPrev.find((t) => t !== TOPIC_TAX_AUDIT && t !== "家族給与・家族役員") ?? "";

    subjectTopic = altNow || (continuationLike ? altPrev : "") || "";

    if (!subjectTopic) {
      if (hasCashConcern(recentText)) subjectTopic = "会社成長";
      else if (hasOpsPain(recentText)) subjectTopic = "ラク・管理";
    }
  }

  const hasAuditNow = topicsNow.includes(TOPIC_TAX_AUDIT) || hasTaxAuditWords(message);
  const hasAuditRecent = hasTaxAuditWords(recentText) || hasTaxAuditWords(prevAssistantMessage ?? "");
  const taxAuditContextActive = hasAuditNow || topicsPrev.includes(TOPIC_TAX_AUDIT) || hasAuditRecent;

  const overlayWanted = !explicitTaxOff && Boolean(subjectTopic) && AUDIT_OVERLAY_TOPICS.has(subjectTopic);

  const lineRequest = looksLineRequest(message);
  const subjectIsExempt = Boolean(subjectTopic) && AUDIT_STICKY_EXEMPT_TOPICS.has(subjectTopic);

  const shouldUnstickForExempt =
    subjectIsExempt &&
    !hasTaxAuditWords(message) &&
    !lineRequest &&
    !overlayWanted &&
    !topicsNow.includes(TOPIC_TAX_AUDIT);

  const taxAuditSticky = taxAuditContextActive && !explicitTaxOff && !explicitTopicShift && !shouldUnstickForExempt;

  const auditAxis = !explicitTaxOff && (taxAuditSticky || topicsNow.includes(TOPIC_TAX_AUDIT) || overlayWanted);

  const axisTopic = auditAxis ? TOPIC_TAX_AUDIT : topicsNow[0] ?? "";

  let reason = "normal";
  if (explicitTaxOff) reason = "explicit_tax_audit_off";
  else if (explicitTopicShift) reason = "explicit_topic_shift";
  else if (topicsNow.includes(TOPIC_TAX_AUDIT)) reason = "message_mentions_tax_audit";
  else if (taxAuditSticky) reason = "sticky_tax_audit_context";
  else if (overlayWanted) reason = "overlay_by_subject";
  else reason = "no_audit_axis";

  return {
  axisTopic,
  subjectTopic,
  auditAxis,
  taxAuditSticky,
  reason,
  overlayWanted,
  nudgeLines: Boolean(input.llmNudgeLines),
  nudgeReason: String(input.llmNudgeReason ?? ""),
};

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
  usePrevInstead?: boolean;
}): Lens {
  const axis = params.axisTopic;
  const m0 = (params.usePrevInstead ? params.fallbackPrevUser : params.message) ?? params.message;
  const m = (m0 ?? "").trim();

  const hasMoney =
    /([0-9０-９]+)\s*(円|万円|万|千円)|¥\s*[0-9０-９]+|金額|上限|限度|相場|単価|目安|程度|レンジ|幅|いくら|なんぼ/.test(m);

  const hasLineWords = /(上限|限界|ギリ|グレー|安全ライン|アウト|セーフ|攻め|守り|攻守)/.test(m);
  const hasScopeWords = /(どこまで|大丈夫|リスク|安全度|安全性)/.test(m);

  const isSystem =
    /(インボイス|消費税|控除|届出|規程|規定|ルール|手続|要件|仕訳|帳簿|請求書|契約書|稟議|承認)/.test(m) ||
    (/(書類|資料)/.test(m) && /(届出|規程|規定|要件|帳簿|契約書)/.test(m));

  const isAuditOps = /(雑談|反面調査|高圧|態度|圧|雰囲気|資料(全部|提出|要求)|提出リスト|ヒアリング|質問|調査官|国税|税務署)/.test(m);

  if (axis === TOPIC_TAX_AUDIT) {
    if (hasMoney) return "amount";
    if (isAuditOps) return "substance";
    if (hasScopeWords || hasLineWords) {
      return isSystem ? "system" : "substance";
    }
    if (isSystem) return "system";
    return "substance";
  }

  if (hasMoney) return "amount";

  if (hasScopeWords || hasLineWords) {
    return isSystem ? "system" : "substance";
  }

  if (isSystem) return "system";
  return "substance";
}
