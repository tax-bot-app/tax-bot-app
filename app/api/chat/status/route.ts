// app/api/chat/status/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

export const runtime = "nodejs";

export async function GET() {
  try {
    // ✅ Next.js 16: cookies() は Promise
    const cookieStore = await cookies();

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          // ✅ 読み取り専用（更新は middleware が担当）
          getAll() {
            return cookieStore.getAll();
          },
          setAll() {
            // no-op
          },
        },
      }
    );

    const { data } = await supabase.auth.getUser();
    const user = data?.user;

    if (!user) {
      return NextResponse.json({
        ok: true,
        plan: "free",
        used_talks: 0,
        limit_talks: 0,
      });
    }

    const month = new Date().toISOString().slice(0, 7);

    const { data: usage, error } = await supabase
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
      plan: "active",
      used_talks: usage?.used_talks ?? 0,
      limit_talks: usage?.limit_talks ?? 0,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}
