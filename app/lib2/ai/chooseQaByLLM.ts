import OpenAI from "openai";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export type QaCandidateThin = {
  id: string;
  title: string;
  summary: string; // 要点2行くらい
  priority: number;
  bucket: "subject" | "audit" | "other";
};

export type ChooseQaResult = {
  ok: boolean;
  selectedIds: string[];
  reasons: Record<string, string>;
  rawText?: string;
  error?: string;
};

export async function chooseQaByLLM(params: {
  message: string;
  candidates: QaCandidateThin[];
}): Promise<ChooseQaResult> {
  try {
    const openai = new OpenAI({
      apiKey: mustEnv("OPENAI_API_KEY"),
    });

    const model = process.env.OPENAI_MODEL || "gpt-5.2";

    const { message, candidates } = params;

    const listText = candidates
      .map(
        (c, i) =>
          `(${i + 1}) id=${c.id}\n` +
          `title: ${c.title}\n` +
          `priority: ${c.priority}\n` +
          `bucket: ${c.bucket}\n` +
          `summary: ${c.summary}\n`
      )
      .join("\n");

    const instructions = `
あなたはQAカードの選抜エンジンです。
ユーザーの質問に最も適したカードを2枚だけ選んでください。

ルール：
- 必ず2枚選ぶ
- priority70以上は選ばない（それは別途固定される）
- subjectバケットを優先する
- 内容が具体的に刺さるものを優先する
- 出力はJSONのみ

出力形式:
{
  "selectedIds": ["id1", "id2"],
  "reasons": {
    "id1": "理由20文字以内",
    "id2": "理由20文字以内"
  }
}
`;

    const inputText = `
ユーザー質問:
${message}

候補カード一覧:
${listText}
`;

    const ai = await openai.responses.create({
      model,
      instructions,
      input: inputText,
    });

    const raw = ai.output_text?.trim() || "";

    if (!raw) {
      return { ok: false, selectedIds: [], reasons: {}, error: "empty response" };
    }

    const jsonStart = raw.indexOf("{");
    const jsonText = raw.slice(jsonStart);

    const parsed = JSON.parse(jsonText);

    return {
      ok: true,
      selectedIds: parsed.selectedIds || [],
      reasons: parsed.reasons || {},
      rawText: raw,
    };
  } catch (e: any) {
    return {
      ok: false,
      selectedIds: [],
      reasons: {},
      error: e?.message || "LLM selection failed",
    };
  }
}
