// app/auth/callback/route.ts
import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

export const runtime = "nodejs";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export async function GET(req: Request) {
  const url = new URL(req.url);

  // plan は保持（クエリで来る）
  const plan = String(url.searchParams.get("plan") ?? "").toLowerCase();
  const safePlan = ["lite", "standard", "enterprise"].includes(plan) ? plan : "";

  // Supabase が返す code をセッションに交換
  const code = url.searchParams.get("code");

  const res = NextResponse.redirect(
    new URL(safePlan ? `/checkout?plan=${encodeURIComponent(safePlan)}` : "/chat", url.origin)
  );

  if (!code) {
    // code が無い＝認証失敗 or 直アクセス。loginへ返す
    return NextResponse.redirect(new URL(safePlan ? `/login?plan=${encodeURIComponent(safePlan)}` : "/login", url.origin));
  }

  const supabase = createServerClient(
    mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
    mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll() {
          // route handler では req から取れないので空でOK（交換が主目的）
          return [];
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            res.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  // ✅ ここが本丸：code -> session cookie
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(new URL(`/login?reason=expired${safePlan ? `&plan=${encodeURIComponent(safePlan)}` : ""}`, url.origin));
  }

  return res;
}