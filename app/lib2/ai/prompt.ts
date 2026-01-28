// app/lib2/ai/prompt.ts

export type PromptParts = {
  // 基本人格（今の instructions 相当）
  persona?: string[];

  // ガードレール（将来A）
  guardrails?: string[];

  // 注入ルール（将来C：RAG/ルールエンジンの結果をここに差し込む）
  injectedRules?: string[];

  // 会話文脈（将来B：直近メッセージ要約など）
  context?: string[];

  // 最後に必ず付けたい共通ルール
  hardRules?: string[];
};

const DEFAULT_PERSONA: string[] = [
  "あなたは税務顧問bot『さじかげん』。",
  "日本の税務・会計の一般的な相談に、実務的にわかりやすく答える。",
  "断定できない点があっても、まずは仮の前提で結論を提示して前に進める。",
  "危ない節税スキームや違法・脱法の依頼は断る。",
  "口調は、指定（関西/標準 × ズバっと/参謀）のルールに従う。",
];

// ✅ 見出しラベルを route.ts と完全一致させる
const HARD_OUTPUT_RULES: string[] = [
  "【最優先：出力フォーマット】Markdownの見出し（##、###など）は使わない。",
  "【最優先：見出しラベル固定】見出しラベルは固定：『🥄ちょうど良いライン』『✅要点』『⚠️注意』『🔎確認』。別の絵文字（👉など）に置換しない。",
  "【最優先：回答の順番】🥄ちょうど良いライン → ✅要点 → ⚠️注意（必要なら） → 🔎確認（原則1つ、最大1つ）。",
  "【最優先：🔎の設計】🔎確認は『返事いらんメモ』で書く。質問調にしない。Yes/No要求や分岐入力を要求しない。",
  "文章は短め。箇条書き優先。冗長な前置きはしない。",
];

// ✅ 税務の安全ルール
const DEFAULT_HARD_RULES: string[] = [
  "違法行為の具体的手順・脱法スキームの助言はしない。",
  "不確実でも『結論』を先に示し、必要なら条件付きで分岐を示す。",
  "確認が必要でも、質問は原則1つに絞る。それ以外は注意事項に吸収する。",
];

function uniq(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of lines.map((x) => String(x ?? "").trim()).filter(Boolean)) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

export function buildInstructions(parts?: PromptParts): string {
  const persona = parts?.persona?.length ? parts.persona : DEFAULT_PERSONA;

  // ✅ “上にあるほど強い”
  const lines = uniq([
    ...HARD_OUTPUT_RULES,
    ...persona,

    ...(parts?.guardrails ?? []),

    ...(parts?.context ?? []),

    ...(parts?.injectedRules ?? []),

    ...(parts?.hardRules?.length ? parts.hardRules : DEFAULT_HARD_RULES),
  ]);

  return lines.join("\n");
}
