import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

// Supabase（Auth取得だけなので anon でOK）
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function extractBearerToken(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1] ?? null;
}

export async function POST(req: NextRequest) {
  try {
    // 1) 認証
    const accessToken = extractBearerToken(req);
    if (!accessToken) {
      return NextResponse.json(
        { error: "missing Authorization Bearer token" },
        { status: 401 }
      );
    }

    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser(accessToken);

    if (userErr || !user) {
      return NextResponse.json({ error: "not authenticated" }, { status: 401 });
    }

    const userId = user.id;

    // 2) 入力
    const body = await req.json().catch(() => ({}));
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    if (!message) {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }

    // 3) users から plan / monthly_quota を読む
    const { data: urow, error: uerr } = await supabase
      .from("users")
      .select("plan, monthly_quota")
      .eq("id", userId)
      .maybeSingle();

    if (uerr) {
      return NextResponse.json(
        { error: `users read failed: ${uerr.message}` },
        { status: 500 }
      );
    }

    const plan = urow?.plan ?? "free";
    const monthlyQuota = urow?.monthly_quota ?? 0;

    if (plan === "free" || monthlyQuota <= 0) {
      return NextResponse.json(
        { error: "no active plan", plan, monthly_quota: monthlyQuota },
        { status: 402 }
      );
    }

    // 4) quota を 1回消費（原子的）
    const { data: consumeRes, error: cerr } = await supabase.rpc("consume_talk", {
      p_user_id: userId,
      p_limit: monthlyQuota,
    });

    if (cerr) {
      return NextResponse.json(
        { error: `consume_talk failed: ${cerr.message}` },
        { status: 500 }
      );
    }

    const allowed = Array.isArray(consumeRes) ? consumeRes[0]?.allowed : null;
    const used_talks = Array.isArray(consumeRes) ? consumeRes[0]?.used_talks : null;
    const limit_talks = Array.isArray(consumeRes) ? consumeRes[0]?.limit_talks : null;

    if (!allowed) {
      return NextResponse.json(
        {
          error: "quota exceeded",
          plan,
          used_talks,
          limit_talks,
        },
        { status: 402 }
      );
    }

    // 5) ここで本来LLM呼ぶ（いまはダミー）
    const reply = `（仮）受け取った: ${message}`;

    return NextResponse.json({
      ok: true,
      plan,
      used_talks,
      limit_talks,
      reply,
    });
  } catch (e: any) {
    console.error(e);
    return NextResponse.json({ error: "chat error" }, { status: 500 });
  }
}
