// app/lib/openaiModel.ts

function clean(v: unknown) {
  return String(v ?? "").trim();
}

/**
 * モデル指定はここに集約。
 * 変更は Vercel の ENV 差し替えだけで済む。
 *
 * 優先順位：
 *  - 用途別（TOPIC / SMALL）
 *  - 共通（OPENAI_MODEL）
 *  - フォールバック（5.4系）
 */
export function getOpenAIModel(
  purpose: "main" | "topic" | "small" = "main"
): string {
  const common = clean(process.env.OPENAI_MODEL);
  const topic = clean(process.env.OPENAI_MODEL_TOPIC);
  const small = clean(process.env.OPENAI_MODEL_SMALL);

  // ★ベース：5.4
  const fallbackMain = "gpt-5.4";
  const fallbackSmall = "gpt-5.4-mini";

  if (purpose === "topic") return topic || common || fallbackSmall;
  if (purpose === "small") return small || common || fallbackSmall;
  return common || fallbackMain;
}

function splitModels(v: unknown): string[] {
  return clean(v)
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
}

/**
 * 実行時フォールバック候補。
 *
 * OPENAI_MODEL_FALLBACKS は用途共通、用途別ENVはその手前で試す。
 * 同一モデルは除外し、指定順を維持する。
 */
export function getOpenAIModelCandidates(
  purpose: "main" | "topic" | "small" = "main"
): string[] {
  const purposeFallbacks = splitModels(
    purpose === "main"
      ? process.env.OPENAI_MODEL_MAIN_FALLBACKS
      : purpose === "topic"
        ? process.env.OPENAI_MODEL_TOPIC_FALLBACKS
        : process.env.OPENAI_MODEL_SMALL_FALLBACKS
  );
  const commonFallbacks = splitModels(process.env.OPENAI_MODEL_FALLBACKS);
  // ENV追加前でも、現行既定値の終了で即停止しないための最後の保険。
  // 新世代公開時はENVを先に更新し、コード既定値は定期メンテで追随する。
  const emergencyDefaults =
    purpose === "main" ? ["gpt-5.6-sol"] : ["gpt-5.4-mini", "gpt-5.6-sol"];

  return Array.from(
    new Set([
      getOpenAIModel(purpose),
      ...purposeFallbacks,
      ...commonFallbacks,
      ...emergencyDefaults,
    ])
  );
}
