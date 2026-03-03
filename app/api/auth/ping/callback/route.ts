// app/auth/callback/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const plan = String(url.searchParams.get("plan") ?? "").toLowerCase();
  const safePlan = ["lite", "standard", "enterprise"].includes(plan) ? plan : "";

  // 認証が完了したら、あとは checkout に投げる
  const next = safePlan ? `/checkout?plan=${encodeURIComponent(safePlan)}` : "/";

  return NextResponse.redirect(new URL(next, url.origin));
}