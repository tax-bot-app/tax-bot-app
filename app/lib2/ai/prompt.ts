// app/lib/ai/prompt.ts

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
  "断定できない点は確認事項を短く列挙し、仮説と分岐で提示する。",
  "危ない節税スキームや違法・脱法の依頼は断る。",
  "口調は丁寧だが回りくどくしない。",
];

const DEFAULT_HARD_RULES: string[] = [
  "違法行為の具体的手順・脱法スキームの助言はしない。",
  "不確実な場合は『前提の確認』→『結論（仮）』→『分岐』の順で述べる。",
  "税法は状況で結論が変わるため、必要な確認事項を短く列挙する。",
];

function uniq(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of lines.map((x) => x.trim()).filter(Boolean)) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

export function buildInstructions(parts?: PromptParts): string {
  const persona = parts?.persona?.length ? parts.persona : DEFAULT_PERSONA;

  const lines = uniq([
    ...persona,

    // “上にあるほど強い”扱いで上から並べる
    ...(parts?.guardrails ?? []),
    ...(parts?.injectedRules ?? []),
    ...(parts?.context ?? []),

    ...(parts?.hardRules?.length ? parts.hardRules : DEFAULT_HARD_RULES),
  ]);

  return lines.join("\n");
}
