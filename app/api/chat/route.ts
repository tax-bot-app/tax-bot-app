// app/api/chat/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

// ざっくり UUID 形式チェック（DB uuid キャスト失敗を早めに弾く）
function looksUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v
  );
}

// users.monthly_quota が取れない/無い場合の保険
function fallbackLimitFromPlan(plan: string): number {
  switch (plan) {
    case "lite":
      return 5;
    case "standard":
      return 30;
    case "enterprise":
      return 100;
    default:
      return 0;
  }
}

type ChatRes =
  | {
      ok: true;
      plan: string;
      used_talks: number | null;
      limit_talks: number | null;
      message: string;
    }
  | {
      ok: false;
      error: string;
      used_talks?: number | null;
      limit_talks?: number | null;
    };

type ConsumeTalkV2Result = {
  month_key: string;
  used_talks: number;
  limit_talks: number;
  allowed: boolean;
  already_counted: boolean;
};

export async function POST(req: Request) {
  try {
    const token = bearer(req);
    if (!token) {
      const res: ChatRes = { ok: false, error: "Missing bearer token" };
      return NextResponse.json(res, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    const message = body?.message;
    const idempotencyKey = body?.idempotencyKey;

    if (typeof message !== "string" || !message.trim()) {
      const res: ChatRes = { ok: false, error: "message is required" };
      return NextResponse.json(res, { status: 400 });
    }
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
      const res: ChatRes = { ok: false, error: "idempotencyKey is required" };
      return NextResponse.json(res, { status: 400 });
    }
    if (!looksUuid(idempotencyKey)) {
      const res: ChatRes = { ok: false, error: "idempotencyKey must be UUID" };
      return NextResponse.json(res, { status: 400 });
    }

    const url = mustEnv("NEXT_PUBLIC_SUPABASE_URL");
    const anon = mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

    // ① user取得（token指定で確実）
    const authClient = createClient(url, anon, { auth: { persistSession: false } });
    const { data: userRes, error: userErr } = await authClient.auth.getUser(token);
    if (userErr || !userRes?.user) {
      const res: ChatRes = { ok: false, error: "Invalid session" };
      return NextResponse.json(res, { status: 401 });
    }
    const user = userRes.user;

    // ② DBアクセスは Authorization header 付き（RLS効かせる）
    const db = createClient(url, anon, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    // plan / monthly_quota を参照（monthly_quota 列が無い環境でも動くように try）
    let plan = "free";
    let limit = 0;

    // まず monthly_quota あり想定で取得 → 失敗したら plan のみ取得へフォールバック
    const { data: urowA, error: uerrA } = await db
      .from("users")
      .select("plan, monthly_quota")
      .eq("id", user.id)
      .maybeSingle();

    if (!uerrA && urowA) {
      plan = (urowA.plan as string) ?? "free";
      const q = (urowA as any).monthly_quota;
      limit = Number.isFinite(Number(q)) ? Number(q) : fallbackLimitFromPlan(plan);
    } else {
      const { data: urowB } = await db
        .from("users")
        .select("plan")
        .eq("id", user.id)
        .maybeSingle();
      plan = (urowB?.plan as string) ?? "free";
      limit = fallbackLimitFromPlan(plan);
    }

    // free は 0（送信不可）でOK。契約後は 5/30/100 等になる想定
    // ③ カウント（冪等）
    const { data, error } = await db.rpc("consume_talk_v2", {
      p_user_id: user.id,
      p_limit: limit,
      p_idempotency_key: idempotencyKey,
    });

    if (error) {
      const res: ChatRes = { ok: false, error: `consume_talk_v2 failed: ${error.message}` };
      return NextResponse.json(res, { status: 500 });
    }

    const usage = (Array.isArray(data) ? data[0] : data) as ConsumeTalkV2Result | null;
    if (!usage) {
      const res: ChatRes = { ok: false, error: "consume_talk_v2: empty result" };
      return NextResponse.json(res, { status: 500 });
    }

    if (!usage.allowed) {
      const res: ChatRes = {
        ok: false,
        error: "Monthly quota exceeded",
        used_talks: usage.used_talks,
        limit_talks: usage.limit_talks,
      };
      return NextResponse.json(res, { status: 429 });
    }

    // ✅ AI回答は後回し：今は受付メッセージ
    const res: ChatRes = {
      ok: true,
      plan,
      used_talks: usage.used_talks,
      limit_talks: usage.limit_talks,
      message: "受付けました。回答生成は順次対応予定です。",
    };
    return NextResponse.json(res, { status: 200 });
  } catch (e: any) {
    const res: ChatRes = { ok: false, error: e?.message ?? "Unknown error" };
    return NextResponse.json(res, { status: 500 });
  }
}
