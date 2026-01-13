import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-12-15.clover",
});

// Supabase（Authのuser取得だけなので anon でOK）
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const PLAN_TO_PRICE: Record<string, string> = {
  lite: "price_1SmqJoQ3OyVaMed9QdAkDBzA",
  standard: "price_1Sm8qnQ3OyVaMed9WMDOPgLZ",
  enterprise: "price_1Smq2QQ3OyVaMed9uh5CgQfD",
};

function getBaseUrl(req: NextRequest) {
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) return `https://${vercelUrl}`;

  const host = req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}

function extractBearerToken(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1] ?? null;
}

export async function POST(req: NextRequest) {
  try {
    const baseUrl = getBaseUrl(req);

    // ① ログインユーザー特定（フロントから access_token をBearerで渡す前提）
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
      return NextResponse.json(
        { error: "not authenticated" },
        { status: 401 }
      );
    }

    const userId = user.id;
    const userEmail = user.email ?? null;

    // ② ここが肝：body から plan を読む（読めなければ lite）
    const body = await req.json().catch(() => ({}));
    const plan = typeof body?.plan === "string" ? body.plan : "lite";

    const priceId = PLAN_TO_PRICE[plan];
    if (!priceId) {
      return NextResponse.json({ error: "invalid plan" }, { status: 400 });
    }

    // ③ どのpriceを使ってるかログ（確認用）
    console.log("✅ create-checkout", { userId, plan, priceId });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],

      // Webhook側で user.id で更新できる
      client_reference_id: userId,

      ...(userEmail ? { customer_email: userEmail } : {}),

      success_url: `${baseUrl}/success`,
      cancel_url: `${baseUrl}/`,
    });

    return NextResponse.json({ url: session.url });
  } catch (err: any) {
    console.error(err);
    return NextResponse.json({ error: "checkout error" }, { status: 500 });
  }
}
