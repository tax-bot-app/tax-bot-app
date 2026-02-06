import { generateAnswer } from "./generateAnswer";

export type Lens = "substance" | "system" | "amount";

export async function inferLensByLLM(params: {
  message: string;
}): Promise<{ lens: Lens; confidence: number }> {
  const prompt = `
次の相談について、「最初に整理すべき観点」を1つ選んでください。
結論や説明は不要です。

【選択肢】
- substance（実態・運用・中身）
- system（制度・要件・書類・インボイス）
- amount（金額・レンジ・上限）

【相談】
${params.message}

【出力形式（必ずJSON）】
{"lens":"substance|system|amount","confidence":0.0-1.0}
`.trim();

  const result = await generateAnswer({
    message: prompt,
    promptParts: {
      context: [],
      injectedRules: [
        "出力は必ずJSONのみ。余計な文章は禁止。",
      ],
      guardrails: [],
    },
  });

  try {
    const json = JSON.parse(result.answer);
    if (["substance", "system", "amount"].includes(json.lens)) {
      return {
        lens: json.lens,
        confidence: Number(json.confidence) || 0.5,
      };
    }
  } catch {}

  // フェイルセーフ
  return { lens: "substance", confidence: 0.3 };
}
