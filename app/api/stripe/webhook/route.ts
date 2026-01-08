import { NextRequest, NextResponse } from "next/server";
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

export async function POST(req: NextRequest) {
  const sig = req.headers.get("stripe-signature");
  if (!sig) {
    return new Response("No signature", { status: 400 });
  }

  const body = await req.text();

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err) {
    console.error("Webhook signature verify failed:", err);
    return new Response("Invalid signature", { status: 400 });
  }

  try {
    // ✅ 決済完了（サブスク作成）
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      const customerId = session.customer as string;
      const subscriptionId = session.subscription as string;

      if (!customerId || !subscriptionId) {
        console.warn("No customer or subscription id");
        return NextResponse.json({ received: true });
      }

      // 顧客のメール取得
      const customer = await stripe.customers.retrieve(customerId);
      if (!("email" in customer) || !customer.email) {
        console.warn("Customer email not found");
        return NextResponse.json({ received: true });
      }

      // プラン決定（今回は lite 固定でOK）
      const plan = "lite";
      const monthly_quota = 5;

      // users テーブル更新
      const { error } = await supabase
        .from("users")
        .update({
          plan,
          monthly_quota,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          updated_at: new Date().toISOString(),
        })
        .eq("email", customer.email);

      if (error) {
        console.error("Supabase update error:", error);
        return new Response("DB error", { status: 500 });
      }

      console.log("User upgraded:", customer.email);
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error("Webhook handler error:", err);
    return new Response("Webhook error", { status: 500 });
  }
}
