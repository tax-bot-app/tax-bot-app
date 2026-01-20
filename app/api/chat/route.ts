// app/api/chat/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function getSupabaseUrl(): string {
  return (
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    ""
  );
}

function getSupabaseAnonKey(): string {
  return (
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    ""
  );
}

type ConsumeTalkV2Result = {
  month_key: string; // 'YYYY-MM'
  used_talks: number;
  limit_talks: number;
  allowed: boolean;
  already_counted: boolean;
};

type ChatOk = {
  ok: true;
  message: string; // 仮返答（後でAI回答に差し替え）
  usage: ConsumeTalkV2Result;
};

type ChatNg = {
  ok: false;
  error: string;
  code?:
    | "UNAUTHORIZED"
    | "BAD_REQUEST"
    | "RATE_LIMIT"
    | "SERVER_ERROR";
  usage?: ConsumeTalkV2Result; // allowed=false の時に返せる
};

export async function POST(req: Request) {
  try {
    const auth = req.headers.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

    if (!token) {
      const res: ChatNg = {
        ok: false,
        code: "UNAUTHORIZED",
        error: "Missing Authorization Bearer token",
      };
      return NextResponse.json(res, { status: 401 });
    }

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

    const supabaseUrl = getSupabaseUrl();
    const supabaseAnonKey = getSupabaseAnonKey();
    if (!supabaseUrl || !supabaseAnonKey) {
      const res: ChatNg = {
        ok: false,
        code: "SERVER_ERROR",
        error: "Supabase env is missing",
      };
      return NextResponse.json(res, { status: 500 });
    }

    // JWT付きで呼ぶ（auth.uid() を成立させる本線）
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    // RPC 実行：関数の引数名はDB側に合わせてる想定（変えてたらここだけ直す）
    const { data, error } = await supabase.rpc("consume_talk_v2", {
      p_idempotency_key: idempotencyKey,
    });

    if (error) {
      // DB側の例外はここに来る
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
        error: "consume_talk_v2 returned unexpected shape",
      };
      return NextResponse.json(res, { status: 500 });
    }

    if (!usage.allowed) {
      // ここが “回数上限” のハンドリング起点
      const res: ChatNg = {
        ok: false,
        code: "RATE_LIMIT",
        error: "Monthly quota exceeded",
        usage,
      };
      return NextResponse.json(res, { status: 429 });
    }

    // まだAI呼び出しは未実装の方針なので仮返答
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
