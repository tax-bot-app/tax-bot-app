// app/api/demo-chat/route.ts
import { NextResponse } from "next/server";
import { generateAnswer } from "../../lib2/ai/generateAnswer";
import { judgeGuardrails } from "../../lib2/guardrails";

export const runtime = "nodejs";

type Body = {
  message?: string;
};

function stripLegacySections(text: string): string {
  // 万一LLMが癖で出した場合の保険
  return text
    .replace(/🥄ちょうど良いライン[\s\S]*?(?=\n\n|$)/g, "")
    .replace(/✅要点[\s\S]*?(?=\n\n|$)/g, "")
    .replace(/⚠️注意[\s\S]*?(?=\n\n|$)/g, "")
    .replace(/🔎確認[\s\S]*?(?=\n\n|$)/g, "")
    .trim();
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const message = (body?.message ?? "").trim();

    if (!message) {
      return NextResponse.json(
        { ok: false, error: "message is required" },
        { status: 400 }
      );
    }

    // 本番と同じガードレール
    const guardrail = await judgeGuardrails({ message });

    if (guardrail.action === "block") {
      return NextResponse.json({
        ok: true,
        answer:
          "その内容はお手伝いできません。\n合法な範囲で整理する方向ならご相談ください。",
      });
    }

    const { answer } = await generateAnswer({
      message,
      promptParts: {
        outputMode: "demo",
        persona: [
          "口調は標準語、参謀スタイル。",
        ],
      },
    });

    const cleaned = stripLegacySections(answer);

    return NextResponse.json({ ok: true, answer: cleaned });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "error" },
      { status: 500 }
    );
  }
}
