import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-12-15.clover",
});

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const PRICE_TO_PLAN: Record<string, { plan: string; monthly_quota: number }> = {
  // 例（自分のpriceIdに置き換え）
  // "price_XXXX": { plan: "lite", monthly_quota: 5 },
  // "price_YYYY": { plan: "pro", monthly_quota: 50 },
};

function planFromPrice(priceId?: string | null) {
  if (!priceId) return { plan: "free", monthly_quota: 0 };
  return PRICE_TO_PLAN[priceId] ?? { plan: "free", monthly_quota: 0 };
}

async function upsertUser(params: {
  email: string;
  plan: string;
  monthly_quota: number;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
}) {
  const { error } = await supabase.from("users").upsert(
    {
      email: params.email,
      plan: params.plan,
      monthly_quota: params.monthly_quota,
      stripe_customer_id: params.stripe_customer_id ?? null,
      stripe_subscription_id: params.stripe_subscription_id ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "email" }
  );

  if (error) throw error;
}

// デバッグ用（ブラウザで開いたとき確認）
export async function GET() {
  return NextResponse.json({ ok: true, route: "/api/stripe/webhook", method: "GET" });
}

export async function POST(req: Request) {
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new NextResponse("No signature", { status: 400 });

  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (err: any) {
    return new NextResponse(`Webhook Error: ${err?.message ?? "invalid signature"}`, { status: 400 });
  }

  try {
    // checkout完了（初回決済）
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      const email =
        session.customer_details?.email ||
        session.customer_email ||
        null;

      if (!email) {
        return NextResponse.json({ received: true, note: "no email on session" }, { status: 200 });
      }

      const subId = typeof session.subscription === "string" ? session.subscription : null;
      const cusId = typeof session.customer === "string" ? session.customer : null;

      let priceId: string | null = null;
      let subStatus: string | null = null;

      if (subId) {
        const sub = await stripe.subscriptions.retrieve(subId, {
          expand: ["items.data.price"],
        });
        priceId = sub.items.data?.[0]?.price?.id ?? null;
        subStatus = sub.status ?? null;
      }

      const { plan, monthly_quota } = planFromPrice(priceId);

      const isActive = subStatus ? ["active", "trialing"].includes(subStatus) : true;

      await upsertUser({
        email,
        plan: isActive ? plan : "free",
        monthly_quota: isActive ? monthly_quota : 0,
        stripe_customer_id: cusId,
        stripe_subscription_id: subId,
      });

      return NextResponse.json({ received: true }, { status: 200 });
    }

    // サブスク更新/キャンセル等（運用で効いてくる）
    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const sub = event.data.object as Stripe.Subscription;

      const cusId = typeof sub.customer === "string" ? sub.customer : null;
      if (!cusId) return NextResponse.json({ received: true, note: "no customer id" }, { status: 200 });

      const customer = (await stripe.customers.retrieve(cusId)) as Stripe.Customer;
      const email = customer.email;
      if (!email) return NextResponse.json({ received: true, note: "no customer email" }, { status: 200 });

      const priceId = sub.items.data?.[0]?.price?.id ?? null;
      const { plan, monthly_quota } = planFromPrice(priceId);

      const isActive = ["active", "trialing"].includes(sub.status);

      await upsertUser({
        email,
        plan: isActive ? plan : "free",
        monthly_quota: isActive ? monthly_quota : 0,
        stripe_customer_id: cusId,
        stripe_subscription_id: sub.id,
      });

      return NextResponse.json({ received: true }, { status: 200 });
    }

    return NextResponse.json({ received: true, ignored: true, type: event.type }, { status: 200 });
  } catch (err: any) {
    // 500返すとStripeがリトライしまくるので、まずは200で落ち着かせる
    console.error("webhook handler error:", err);
    return NextResponse.json({ received: true, error: err?.message ?? String(err) }, { status: 200 });
  }
}
