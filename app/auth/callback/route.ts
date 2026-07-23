// app/auth/callback/route.ts
import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { siteOrigin } from "../../lib/siteOrigin";

export const runtime = "nodejs";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const appUrl = siteOrigin();
  const cookieStore = await cookies();

  // plan は保持（クエリで来る）
  const plan = String(url.searchParams.get("plan") ?? "").toLowerCase();
  const safePlan = ["lite", "standard", "enterprise"].includes(plan) ? plan : "";

  // Supabase が返す code をセッションに交換
  const code = url.searchParams.get("code");

  const res = NextResponse.redirect(
    new URL(safePlan ? `/checkout?plan=${encodeURIComponent(safePlan)}` : "/?plans=1", appUrl)
  );

  if (!code) {
    // code が無い＝認証失敗 or 直アクセス。loginへ返す
    return NextResponse.redirect(new URL(safePlan ? `/login?plan=${encodeURIComponent(safePlan)}` : "/login", appUrl));
  }

  const supabase = createServerClient(
    mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
    mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll() {
          // ✅ callback の“受け取ったcookie”を渡す（これが無いと交換が不安定になる）
          return cookieStore.getAll();
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
    return NextResponse.redirect(new URL(`/login?reason=expired${safePlan ? `&plan=${encodeURIComponent(safePlan)}` : ""}`, appUrl));
  }

  return res;
}
