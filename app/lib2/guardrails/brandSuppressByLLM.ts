// app/lib2/guardrails/brandSuppressByLLM.ts
import OpenAI from "openai";
import type { GuardrailDecision } from "./judge";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function safeJsonParse(s: string): any | null {
  const t = (s ?? "").trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    const i = t.indexOf("{");
    const j = t.lastIndexOf("}");
    if (i >= 0 && j > i) {
      try {
        return JSON.parse(t.slice(i, j + 1));
      } catch {}
    }
    return null;
  }
}

export type BrandSuppressDecision = {
  suppressBranding: boolean;
  reason: string; // internal
};

// app/lib2/guardrails/brandSuppressByLLM.ts

export async function decideSuppressBrandingByLLM(args: {
  message: string;
  prevUser?: string | null;
  prevAssistant?: string | null;
  guardrail: GuardrailDecision;
  carryRisk?: boolean;
}): Promise<BrandSuppressDecision> {
  const { message, prevUser, prevAssistant, guardrail, carryRisk } = args;

  // block はルール側で確定（LLM不要）
  if (guardrail.action === "block") {
    return { suppressBranding: true, reason: `rule:block:${guardrail.reason}` };
  }

  // ★追加：inject も確定ON（LLM不要・ぶれさせない）
  if (guardrail.action === "inject") {
    return { suppressBranding: true, reason: `rule:inject:${guardrail.reason}` };
  }

  // ここから先は guardrail.action === "none" しか来ない
  const openai = new OpenAI({ apiKey: mustEnv("OPENAI_API_KEY") });
  const model = process.env.OPENAI_MODEL || "gpt-5.2";

  const instruction = [
    "あなたは会話の『ブランド口上』を抑制すべきかどうかだけ判定する分類器。",
    "出力はJSONのみ。他の文章は禁止。",
    "",
    "ブランド口上とは：文末の決めゼリフ（例：🔎確認～）や、キャッチフレーズ（例：🥄ちょうど良いライン）や、CTA（👉続き…）など。",
    "",
    "次のとき suppressBranding=true：",
    "- ユーザーが不正/脱税/改ざん/売上除外/虚偽申告/調査で嘘 などの意図を含む相談",
    "- 回答が『拒否・強い注意喚起』寄りで、口上があると煽り/営業臭/挑発に見えるとき",
    "",
    "次のとき suppressBranding=false：通常の税務相談・合法的な設計相談・前提確認。",
    "",
    `{"suppressBranding": true|false, "reason": "short_internal_reason"}`,
  ].join("\n");

  const input = [
    `message: ${message}`,
    carryRisk ? (prevUser ? `prevUser: ${prevUser}` : "") : "",
    carryRisk ? (prevAssistant ? `prevAssistant: ${prevAssistant}` : "") : "",
    "guardrail: none",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await openai.responses.create({
      model,
      instructions: instruction,
      input,
      temperature: 0.2,
    } as any);

    const text = (res.output_text ?? "").trim();
    const obj = safeJsonParse(text);

    const suppress = !!obj?.suppressBranding;
    const reason = typeof obj?.reason === "string" ? obj.reason : "llm:no_reason";

    return { suppressBranding: suppress, reason: `llm:${reason}` };
  } catch (e: any) {
    // ★ここには inject が来ないので分岐不要
    return { suppressBranding: false, reason: "fallback:none" };
  }
}

