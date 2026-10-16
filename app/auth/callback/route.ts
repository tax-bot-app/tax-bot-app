// app/auth/callback/route.ts
import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { siteOrigin } from "../../lib/siteOrigin";
import { isSinglePurchaseKey } from "../../lib/singlePurchase";

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
  const purchase = String(url.searchParams.get("purchase") ?? "").toLowerCase();
  const safePurchase = isSinglePurchaseKey(purchase) ? purchase : "";
  const checkoutPath = safePlan
    ? `/checkout?plan=${encodeURIComponent(safePlan)}`
    : safePurchase
      ? `/checkout?purchase=${encodeURIComponent(safePurchase)}`
      : "/?plans=1";

  // Supabase が返す code をセッションに交換
  const code = url.searchParams.get("code");

  const res = NextResponse.redirect(
    new URL(checkoutPath, appUrl)
  );

  if (!code) {
    // code が無い＝認証失敗 or 直アクセス。loginへ返す
    const loginPath = safePlan
      ? `/login?plan=${encodeURIComponent(safePlan)}`
      : safePurchase
        ? `/login?purchase=${encodeURIComponent(safePurchase)}`
        : "/login";
    return NextResponse.redirect(new URL(loginPath, appUrl));
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
    const checkoutQuery = safePlan
      ? `&plan=${encodeURIComponent(safePlan)}`
      : safePurchase
        ? `&purchase=${encodeURIComponent(safePurchase)}`
        : "";
    return NextResponse.redirect(new URL(`/login?reason=expired${checkoutQuery}`, appUrl));
  }

  return res;
}
