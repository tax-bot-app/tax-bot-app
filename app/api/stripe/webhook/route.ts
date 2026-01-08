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

// まずは1プラン運用（あとで priceId マップに拡張OK）
const LITE_PLAN = { plan: "lite", monthly_quota: 5 };

async function upsertUserByEmail(params: {
  email: string;
  plan: string;
  monthly_quota: number;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
}) {
  const { email, plan, monthly_quota, stripe_customer_id, stripe_subscription_id } = params;

  // email をユニーク前提（あなたのテーブル構造に合わせて upsert）
  const { error } = await supabase.from("users").upsert(
    {
      email,
      plan,
      monthly_quota,
      stripe_customer_id: stripe_customer_id ?? null,
      stripe_subscription_id: stripe_subscription_id ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "email" }
  );

  if (error) throw error;
}

export async function POST(req: Request) {
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("No stripe-signature", { status: 400 });

  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err: any) {
    console.error("Webhook signature verification failed:", err?.message);
    return new Response(`Webhook Error: ${err?.message}`, { status: 400 });
  }

  try {
    // ✅ 決済完了（Checkout）で lite 付与（まずはここが動けば勝ち）
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      const email =
        session.customer_details?.email ||
        session.customer_email ||
        undefined;

      if (!email) {
        console.warn("checkout.session.completed: missing email", session.id);
        return new Response(JSON.stringify({ received: true }), { status: 200 });
      }

      const stripe_customer_id =
        typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;

      const stripe_subscription_id =
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id ?? null;

      await upsertUserByEmail({
        email,
        plan: LITE_PLAN.plan,
        monthly_quota: LITE_PLAN.monthly_quota,
        stripe_customer_id,
        stripe_subscription_id,
      });

      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }

    // ✅ サブスク更新系も拾う（保険）
    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const sub = event.data.object as Stripe.Subscription;

      const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      const customer = (await stripe.customers.retrieve(customerId)) as Stripe.Customer;

      const email = customer.email || undefined;
      if (!email) {
        console.warn("subscription.*: missing customer email", customerId);
        return new Response(JSON.stringify({ received: true }), { status: 200 });
      }

      const active = ["active", "trialing"].includes(sub.status);
      await upsertUserByEmail({
        email,
        plan: active ? LITE_PLAN.plan : "free",
        monthly_quota: active ? LITE_PLAN.monthly_quota : 0,
        stripe_customer_id: customerId,
        stripe_subscription_id: sub.id,
      });

      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }

    // それ以外は受領だけ
    return new Response(JSON.stringify({ received: true }), { status: 200 });
  } catch (err: any) {
    console.error("Webhook handler failed:", err?.message || err);
    return new Response("Webhook handler failed", { status: 500 });
  }
}
