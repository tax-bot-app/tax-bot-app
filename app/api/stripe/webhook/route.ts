import { NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-12-15.clover",
});

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: Request) {
  const sig = req.headers.get("stripe-signature");
  if (!sig) {
    return NextResponse.json({ error: "No signature" }, { status: 400 });
  }

  const body = await req.text();

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err: any) {
    console.error("Webhook signature verification failed.", err.message);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // ✅ 決済完了イベント処理
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;

    const email = session.customer_details?.email;
    const customerId = session.customer as string | null;
    const subscriptionId = session.subscription as string | null;

    if (!email) {
      console.warn("No email in checkout session");
      return NextResponse.json({ ok: true });
    }

    const { error } = await supabase
      .from("users")
      .update({
        plan: "lite",
        monthly_quota: 5,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        updated_at: new Date().toISOString(),
      })
      .eq("email", email);

    if (error) {
      console.error("Supabase update error:", error);
      return NextResponse.json({ error: "DB update failed" }, { status: 500 });
    }
  }

  return NextResponse.json({ received: true });
}
