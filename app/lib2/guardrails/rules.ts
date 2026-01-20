// app/lib2/guardrails/rules.ts

export type GuardrailLevel = 1 | 2 | 3;

export type GuardrailHit = {
  level: GuardrailLevel;
  reason: string; // internal only
};

type Rule = {
  level: GuardrailLevel;
  reason: string;
  patterns: (string | RegExp)[];
};

// NOTE:
// - ここは「完全一致」より「匂い検知」重視
// - ただし誤検知が致命的になるワードは入れすぎない（あなたの思想に合わせる）

export const RULES: Rule[] = [
  // =========================
  // 🟥 Level 1: 即ブロック（不正の具体手順/証拠改ざん/所得隠し）
  // =========================
  {
    level: 1,
    reason: "fake_expense_or_receipt_forgery",
    patterns: [
      "架空経費",
      "架空請求",
      "架空の領収書",
      "領収書作って",
      "領収書つくって",
      "領収書偽造",
      "請求書偽造",
      "改ざん",
      "改竄",
      "偽造",
      "二重帳簿",
      "裏帳簿",
      /領収書.*(作|つく)/i,
      /(請求書|領収書).*(偽造|改ざん|改竄)/i,
    ],
  },
  {
    level: 1,
    reason: "income_hiding_or_sales_omission",
    patterns: [
      "売上抜く",
      "売上を抜く",
      "売上除外",
      "売上計上しない",
      "計上しない",
      "現金売上を抜く",
      "所得隠し",
      "申告しない",
      "税務署をごまかす",
      "税務署を誤魔化す",
      "バレない方法",
      "ばれない方法",
      /売上.*(抜|除外|計上しない)/i,
      /(所得|売上).*(隠|抜)/i,
      /(税務署).*(ごまか|誤魔化|だま)/i,
      /(バレない|ばれない).*(方法|やり方)/i,
    ],
  },
  {
    level: 1,
    reason: "audit_lie_guidance",
    patterns: [
      "税務調査で嘘",
      "税務調査でうそ",
      "口裏合わせ",
      "どう言えば逃げれる",
      "どう言えば逃げられる",
      "追及されたら",
      /調査.*(嘘|うそ|口裏|逃げ)/i,
    ],
  },

  // =========================
  // 🟧 Level 2: 注意喚起＋安全回答（脱法臭/偽装リスク）
  // =========================
  {
    level: 2,
    reason: "scheme_like_or_name_change",
    patterns: [
      "スキーム",
      "名義変更",
      "保険で抜く",
      "生命保険で抜く",
      "裏技",
      "抜け道",
      "うまく抜ける",
      /名義.*(変|変更)/i,
      /(保険|生命保険).*(抜|回収)/i,
    ],
  },
  {
    level: 2,
    reason: "misclassification_outsourcing",
    patterns: [
      "外注にしたら",
      "業務委託にしたら",
      "業務委託で",
      "社保払いたくない",
      "社会保険払いたくない",
      "源泉逃れ",
      "給与じゃないことに",
      /業務委託.*(社保|社会保険|源泉)/i,
      /(外注|業務委託).*(逃|払いたくない)/i,
    ],
  },
  {
    level: 2,
    reason: "private_mixture_risky",
    patterns: [
      "プライベートも経費",
      "私用も経費",
      "家族旅行を出張",
      "出張にして落とす",
      "飲み屋全部",
      /旅行.*(出張|経費)/i,
      /(私用|プライベート).*(経費)/i,
    ],
  },

  // =========================
  // 🟨 Level 3: ジャンル制御（断定禁止）
  // =========================
  {
    level: 3,
    reason: "medical",
    patterns: [
      "診断して",
      "病名",
      "治療",
      "薬は",
      "投薬",
      "手術",
      /この症状.*(何|なに)の病気/i,
    ],
  },
  {
    level: 3,
    reason: "investment",
    patterns: [
      "買いですか",
      "売りですか",
      "この銘柄",
      "利回り保証",
      "必ず儲かる",
      "勝てる",
      /株.*(買|売)/i,
      /(投資|株|仮想通貨).*(儲|勝て|必ず)/i,
    ],
  },
  {
    level: 3,
    reason: "legal",
    patterns: [
      "訴えたら勝てる",
      "違法ですか",
      "合法ですか",
      "裁判",
      "刑事",
      "逮捕",
      /これ.*(違法|合法)/i,
      /勝てる\?/i,
    ],
  },
];

export function detectGuardrailHit(text: string): GuardrailHit | null {
  const t = (text || "").toLowerCase();

  for (const rule of RULES) {
    for (const p of rule.patterns) {
      if (typeof p === "string") {
        if (t.includes(p.toLowerCase())) {
          return { level: rule.level, reason: rule.reason };
        }
      } else {
        if (p.test(text)) {
          return { level: rule.level, reason: rule.reason };
        }
      }
    }
  }
  return null;
}
