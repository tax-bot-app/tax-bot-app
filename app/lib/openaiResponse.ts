import OpenAI from "openai";
import { getOpenAIModelCandidates } from "./openaiModel";

export type OpenAIModelPurpose = "main" | "topic" | "small";

type ModelError = {
  status?: number;
  code?: string;
  message?: string;
  error?: { code?: string; message?: string };
};

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

function isModelUnavailableError(error: unknown): boolean {
  const e = error as ModelError;
  const code = String(e?.code ?? e?.error?.code ?? "").toLowerCase();
  const message = String(e?.message ?? e?.error?.message ?? "").toLowerCase();

  if (["model_not_found", "model_not_available"].includes(code)) return true;
  if (![400, 403, 404].includes(Number(e?.status))) return false;

  return (
    message.includes("model") &&
    ["not found", "does not exist", "not available", "access"].some((part) =>
      message.includes(part)
    )
  );
}

function isCandidateIncompatibleError(error: unknown): boolean {
  const e = error as ModelError;
  const code = String(e?.code ?? e?.error?.code ?? "").toLowerCase();
  const message = String(e?.message ?? e?.error?.message ?? "").toLowerCase();
  return (
    isModelUnavailableError(error) ||
    code === "unsupported_parameter" ||
    message.includes("unsupported parameter")
  );
}

async function discoverEmergencyModels(
  openai: OpenAI,
  excluded: Set<string>
): Promise<string[]> {
  const found: Array<{ id: string; created: number }> = [];

  // 一般向けGPTの世代名だけを対象にする。snapshot、Codex、画像・音声等は選ばない。
  const generalGptId = /^gpt-\d+(?:\.\d+)?(?:-(?:sol|terra))?$/;
  for await (const model of openai.models.list()) {
    if (!excluded.has(model.id) && generalGptId.test(model.id)) {
      found.push({ id: model.id, created: Number(model.created ?? 0) });
    }
  }

  return found
    .sort((a, b) => b.created - a.created || b.id.localeCompare(a.id))
    .map((model) => model.id);
}

/**
 * モデル提供終了・アクセス不可のときだけ、次候補で同じリクエストを再試行する。
 * 認証、レート制限、入力不備、OpenAI全体障害では無駄な再試行をしない。
 */
export async function withOpenAIModelFallback<T>(args: {
  purpose: OpenAIModelPurpose;
  run: (openai: OpenAI, model: string) => Promise<T>;
}): Promise<T> {
  const openai = new OpenAI({ apiKey: mustEnv("OPENAI_API_KEY") });
  const candidates = getOpenAIModelCandidates(args.purpose);
  let lastError: unknown;

  for (let index = 0; index < candidates.length; index += 1) {
    const model = candidates[index];
    try {
      const result = await args.run(openai, model);
      if (index > 0) {
        console.warn("[openai-model-fallback] switched model", {
          purpose: args.purpose,
          model,
          failedAttempts: index,
        });
      }
      return result;
    } catch (error) {
      lastError = error;
      if (!isModelUnavailableError(error)) throw error;

      console.warn("[openai-model-fallback] model unavailable; retrying", {
        purpose: args.purpose,
        model,
      });
    }
  }

  // 明示候補がすべて終了していても止めないための最終保険。
  // モデル一覧から厳格な一般向けGPT名だけを抽出し、実際に成功した候補を使う。
  let emergencyModels: string[] = [];
  try {
    emergencyModels = await discoverEmergencyModels(openai, new Set(candidates));
  } catch {
    // models.list 自体が使えない場合は、元のモデルエラーを返す。
  }

  for (const model of emergencyModels) {
    try {
      const result = await args.run(openai, model);
      console.warn("[openai-model-fallback] emergency model selected", {
        purpose: args.purpose,
        model,
      });
      return result;
    } catch (error) {
      lastError = error;
      if (!isCandidateIncompatibleError(error)) throw error;
    }
  }

  throw lastError ?? new Error("No OpenAI model candidate configured");
}
