// app/api/chat/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

export const runtime = "nodejs";

type ConsumeTalkV2Result = {
  month_key: string;
  used_talks: number;
  limit_talks: number;
  allowed: boolean;
  already_counted: boolean;
};

type ChatOk = {
  ok: true;
  message: string;
  usage: ConsumeTalkV2Result;
};

type ChatNg = {
  ok: false;
  error: string;
  code: "UNAUTHORIZED" | "BAD_REQUEST" | "RATE_LIMIT" | "SERVER_ERROR";
  usage?: ConsumeTalkV2Result;
};

async function getSupabase() {
  // ✅ Next.js 16: cookies() は Promise
  const cookieStore = await cookies();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  return createServerClient(url, anon, {
    cookies: {
      // ✅ 読むだけ（更新は middleware が担当）
      getAll() {
        return cookieStore.getAll();
      },
      setAll() {
        // no-op
      },
    },
  });
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const message = body?.message;
    const idempotencyKey = body?.idempotencyKey;

    if (typeof message !== "string" || !message.trim()) {
      const res: ChatNg = {
        ok: false,
        code: "BAD_REQUEST",
        error: "message is required",
      };
      return NextResponse.json(res, { status: 400 });
    }

    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
      const res: ChatNg = {
        ok: false,
        code: "BAD_REQUEST",
        error: "idempotencyKey is required",
      };
      return NextResponse.json(res, { status: 400 });
    }

    const supabase = await getSupabase();

    // ✅ Cookieセッションからユーザー取得
    const { data: authData, error: authErr } = await supabase.auth.getUser();
    if (authErr || !authData?.user) {
      const res: ChatNg = {
        ok: false,
        code: "UNAUTHORIZED",
        error: "Not logged in",
      };
      return NextResponse.json(res, { status: 401 });
    }

    // ✅ ここで月次カウント（冪等キー込み）
    // ※ RPCの引数名はあなたのDB定義に合わせている前提：
    //   p_idempotency_key という引数名で作っているはず。
    const { data, error } = await supabase.rpc("consume_talk_v2", {
      p_idempotency_key: idempotencyKey,
    });

    if (error) {
      const res: ChatNg = {
        ok: false,
        code: "SERVER_ERROR",
        error: `consume_talk_v2 failed: ${error.message}`,
      };
      return NextResponse.json(res, { status: 500 });
    }

    const usage = (Array.isArray(data) ? data[0] : data) as ConsumeTalkV2Result;

    if (!usage || typeof usage.allowed !== "boolean") {
      const res: ChatNg = {
        ok: false,
        code: "SERVER_ERROR",
        error: "Unexpected RPC result shape",
      };
      return NextResponse.json(res, { status: 500 });
    }

    if (!usage.allowed) {
      const res: ChatNg = {
        ok: false,
        code: "RATE_LIMIT",
        error: "Monthly quota exceeded",
        usage,
      };
      return NextResponse.json(res, { status: 429 });
    }

    // ✅ いったんAI回答は後回し（現状仕様）
    const res: ChatOk = {
      ok: true,
      message: "受付けました。回答生成は順次対応予定です。",
      usage,
    };
    return NextResponse.json(res, { status: 200 });
  } catch (e: any) {
    const res: ChatNg = {
      ok: false,
      code: "SERVER_ERROR",
      error: e?.message || "Unknown error",
    };
    return NextResponse.json(res, { status: 500 });
  }
}
