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