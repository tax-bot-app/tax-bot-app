import OpenAI from "openai";
import { getOpenAIModel } from "@/app/lib/openaiModel";

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
   pickN?: number;
  preferBucket?: "subject" | "audit" | "other";
  signal?: AbortSignal;
}): Promise<ChooseQaResult> {
  try {
    const openai = new OpenAI({
      apiKey: mustEnv("OPENAI_API_KEY"),
    });

    const model = getOpenAIModel("small");

    const { message, candidates } = params;
    const pickN = Math.max(1, Math.min(12, Number(params.pickN ?? 2)));
    const preferBucket = params.preferBucket ?? "subject";

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
ユーザーの質問に最も適したカードを${pickN}枚だけ選んでください。

ルール：
- 必ず${pickN}枚選ぶ
- priority70以上は選ばない（それは別途固定される）
- bucket="${preferBucket}" を優先する（ただし内容が刺さらないなら他bucketでも可）
- 内容が具体的に刺さるものを優先する
- 出力はJSONのみ

出力形式:
{
  "selectedIds": ["id1", "id2", "..."],
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

    const ai = await openai.responses.create(
      { model, instructions, input: inputText },
      params.signal ? { signal: params.signal } : undefined
    );

    const raw = ai.output_text?.trim() || "";

    if (!raw) {
      return { ok: false, selectedIds: [], reasons: {}, error: "empty response" };
    }

    const jsonStart = raw.indexOf("{");
    const jsonText = raw.slice(jsonStart);

    const parsed = JSON.parse(jsonText);

    const selectedIds = Array.isArray(parsed.selectedIds) ? parsed.selectedIds.filter(Boolean) : [];
    const reasons = parsed.reasons || {};

    if (selectedIds.length < pickN) {
      return { ok: false, selectedIds, reasons, rawText: raw, error: "too_few_selected" };
    }

    return {
      ok: true,
      selectedIds,
      reasons,
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
