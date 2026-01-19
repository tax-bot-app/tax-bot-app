// app/api/create-checkout/route.ts
import { NextResponse } from "next/server";
import Stripe from "stripe";

import { getPlan, type PlanKey } from "../../lib1/planMaster";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const stripe = new Stripe(mustEnv("STRIPE_SECRET_KEY"), {
  apiVersion: "2025-12-15.clover",
});

type ReqBody = { plan?: PlanKey };

function pickPriceId(planKey: PlanKey): string {
  const plan = getPlan(planKey);
  const priceId = plan.priceIds?.[0];
  if (!priceId) throw new Error(`No priceId configured for plan: ${planKey}`);
  return priceId;
}

export async function POST(req: Request) {
  try {
    const { plan } = (await req.json().catch(() => ({}))) as ReqBody;

    // free は checkout 作らない
    if (!plan || plan === "free") {
      return NextResponse.json({ ok: false, error: "invalid plan" }, { status: 400 });
    }

    const priceId = pickPriceId(plan);

    const origin = req.headers.get("origin") ?? mustEnv("NEXT_PUBLIC_SITE_URL");

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/`,
    });

    return NextResponse.json({ ok: true, url: session.url }, { status: 200 });
  } catch (e: any) {
    console.error("create-checkout error:", e);
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}
