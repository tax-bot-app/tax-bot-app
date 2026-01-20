import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createRouteHandlerClient } from "@supabase/auth-helpers-nextjs";

export const runtime = "nodejs";

export async function GET() {
  try {
    const supabase = createRouteHandlerClient({ cookies });

    const { data: authData, error: authErr } = await supabase.auth.getUser();
    if (authErr || !authData?.user) {
      return NextResponse.json(
        { ok: true, plan: "free", used_talks: 0, limit_talks: 0 },
        { status: 200 }
      );
    }

    // usage を読む（テーブル設計に合わせて調整）
    const month = new Date().toISOString().slice(0, 7); // YYYY-MM
    const { data, error } = await supabase
      .from("usage")
      .select("used_talks, limit_talks")
      .eq("month", month)
      .maybeSingle();

    if (error) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      plan: "active", // ← ここは本来 subscriptions から出す。今は暫定でOK
      used_talks: data?.used_talks ?? 0,
      limit_talks: data?.limit_talks ?? 0,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Unknown error" }, { status: 500 });
  }
}
