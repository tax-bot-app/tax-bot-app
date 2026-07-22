// app/lib2/ai/generateAnswer.ts
import { withOpenAIModelFallback } from "@/app/lib/openaiResponse";
import { buildInstructions, type PromptParts } from "./prompt";

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
  const instructions = buildInstructions(input.promptParts);

  const ai = await withOpenAIModelFallback({
    purpose: "main",
    run: (openai, model) =>
      openai.responses.create(
        { model, instructions, input: input.message },
        input.signal ? { signal: input.signal } : undefined
      ),
  });

  const answer = (ai.output_text && ai.output_text.trim()) || "";
  if (!answer) throw new Error("AI returned empty response");

  return { answer };
}
