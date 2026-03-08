//lib2/ai/decideAnchorQaByLLM.ts
import OpenAI from "openai";
import { getOpenAIModel } from "@/app/lib/openaiModel";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export type AnchorCandidate = {
  id: string;
  title: string;
  summary: string; // 2行くらい
  priority: number;
  topic: string;
};

export type AnchorDecision = {
  ok: boolean;
  anchorQaId: string;        // "" allowed
  confidence: number;        // 0..1
  reason: string;
  rawText?: string;
  error?: string;
};

export async function decideAnchorQaByLLM(params: {
  message: string;
  candidates: AnchorCandidate[]; // picked_qa 由来（最大3）
  signal?: AbortSignal;
}): Promise<AnchorDecision> {
  try {
    const { message, candidates } = params;
    const list = (candidates ?? []).filter(Boolean);
    if (list.length === 0) {
      return { ok: false, anchorQaId: "", confidence: 0, reason: "no_candidates", error: "no_candidates" };
    }

    const openai = new OpenAI({ apiKey: mustEnv("OPENAI_API_KEY") });
    const model = getOpenAIModel("small");

    const listText = list
      .map(
        (c, i) =>
          `(${i + 1}) id=${c.id}\n` +
          `topic: ${c.topic}\n` +
          `priority: ${c.priority}\n` +
          `title: ${c.title}\n` +
          `summary: ${c.summary}\n`
      )
      .join("\n");

    const instructions = `
あなたは「アンカーQA判定」エンジンです。
ユーザー質問に対して、候補の中に「直撃しており、回答の主軸に据えるべきQA」があるかを判定してください。

ルール：
- 直撃がある場合のみ anchorQaId にその id を1つ入れる（1つだけ）
- 自信がない/候補が一般論/どれも同程度なら anchorQaId は空文字 "" にする（無理に選ばない）
- confidence は 0〜1
- reason は短く（30字以内）
- 出力はJSONのみ

出力形式:
{
  "anchorQaId": "id or \\"\\"",
  "confidence": 0.0,
  "reason": "短い理由"
}
`;

    const input = `
ユーザー質問:
${message}

候補QA（最大3）:
${listText}
`;

    const ai = await openai.responses.create(
      {
        model,
        instructions,
        input,
      },
      params.signal ? { signal: params.signal } : undefined
    );

    const raw = ai.output_text?.trim() || "";
    if (!raw) return { ok: false, anchorQaId: "", confidence: 0, reason: "empty", error: "empty response" };

    const jsonStart = raw.indexOf("{");
    const jsonText = jsonStart >= 0 ? raw.slice(jsonStart) : raw;
    const parsed = JSON.parse(jsonText);

    const anchorQaId = String(parsed.anchorQaId ?? "").trim();
    const confidence = Number(parsed.confidence ?? 0);
    const reason = String(parsed.reason ?? "").trim();

    const allowed = new Set(list.map((c) => c.id));
    const finalId = anchorQaId && allowed.has(anchorQaId) ? anchorQaId : "";

    return {
      ok: true,
      anchorQaId: finalId,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
      reason: reason || (finalId ? "anchor" : "none"),
      rawText: raw,
    };
  } catch (e: any) {
    return { ok: false, anchorQaId: "", confidence: 0, reason: "error", error: e?.message || "anchor decision failed" };
  }
}
