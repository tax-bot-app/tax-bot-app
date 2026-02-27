// app/lib2/ai/generateAnswer.ts
import OpenAI from "openai";
import { buildInstructions, type PromptParts } from "./prompt";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export type GenerateAnswerInput = {
  message: string;

  // 将来拡張用（今は未使用でもOK）
  promptParts?: PromptParts;

  // ★Abort用（demo/chat どっちでも使える）
  signal?: AbortSignal;
};


export type GenerateAnswerResult = {
  answer: string;
};

export async function generateAnswer(input: GenerateAnswerInput): Promise<GenerateAnswerResult> {
  const openai = new OpenAI({
    apiKey: mustEnv("OPENAI_API_KEY"),
  });

  const model = process.env.OPENAI_MODEL || "gpt-5.2";

  const instructions = buildInstructions(input.promptParts);

  const ai = await openai.responses.create(
    {
      model,
      instructions,
      input: input.message,
    },
    // ★OpenAI SDKは第2引数で fetch options を受けられる
    input.signal ? { signal: input.signal } : undefined
  );

  const answer = (ai.output_text && ai.output_text.trim()) || "";
  if (!answer) throw new Error("AI returned empty response");

  return { answer };
}
