// app/api/stripe/webhook/route.ts
import Stripe from "stripe";
import { NextResponse } from "next/server";
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

function planFromPrice(priceId?: string | null): { plan: string; monthly_quota: number } {
  // ★ここはあなたの priceId に合わせて増やす
  const PRICE_TO_PLAN: Record<string, { plan: string; monthly_quota: number }> = {
    // 例:
    // "price_XXXXXXXX": { plan: "lite", monthly_quota: 5 },
    // "price_YYYYYYYY": { plan: "pro", monthly_quota: 999 },
  };

  if (priceId && PRICE_TO_PLAN[priceId]) return PRICE_TO_PLAN[priceId];
  return { plan: "free", monthly_quota: 0 };
}

async function upsertUserByEmail(args: {
  email: string;
  plan: string;
  monthly_quota: number;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
}) {
  const { data: existing, error: findErr } = await supabase
    .from("users")
    .select("id")
    .eq("email", args.email)
    .maybeSingle();

  if (findErr) throw findErr;

  if (existing?.id) {
    const { error } = await supabase
      .from("users")
      .update({
        plan: args.plan,
        monthly_quota: args.monthly_quota,
        stripe_customer_id: args.stripe_customer_id ?? null,
        stripe_subscription_id: args.stripe_subscription_id ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from("users").insert({
      email: args.email,
      plan: args.plan,
      monthly_quota: args.monthly_quota,
      stripe_customer_id: args.stripe_customer_id ?? null,
      stripe_subscription_id: args.stripe_subscription_id ?? null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
  }
}

export async function POST(req: Request) {
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("No stripe-signature", { status: 400 });

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return new Response("Missing STRIPE_WEBHOOK_SECRET", { status: 500 });

  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verify failed:", err);
    return new Response("Webhook Error", { status: 400 });
  }

  try {
    // ✅ まずは checkout.session.completed を処理
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      const email = session.customer_details?.email;
      const customerId = typeof session.customer === "string" ? session.customer : null;
      const subscriptionId = typeof session.subscription === "string" ? session.subscription : null;

      if (!email) {
        console.warn("No customer email in session", session.id);
        return NextResponse.json({ received: true, skipped: "no_email" });
      }

      // subscription の priceId を正確に取る（セッションだけだと取れないことがある）
      let priceId: string | null = null;
      if (subscriptionId) {
        const sub = await stripe.subscriptions.retrieve(subscriptionId, {
          expand: ["items.data.price"],
        });
        priceId = sub.items.data?.[0]?.price?.id ?? null;
      }

      const { plan, monthly_quota } = planFromPrice(priceId);

      await upsertUserByEmail({
        email,
        plan,
        monthly_quota,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
      });

      return NextResponse.json({
        received: true,
        handled: "checkout.session.completed",
        email,
        customerId,
        subscriptionId,
        priceId,
        plan,
        monthly_quota,
      });
    }

    // 他イベントはとりあえず受領だけ
    return NextResponse.json({ received: true, ignored: event.type });
  } catch (err) {
    console.error("Webhook handler failed:", err);
    return new Response("Webhook handler error", { status: 500 });
  }
}

// ブラウザで開いたとき用（任意）
export async function GET() {
  return NextResponse.json({ ok: true, route: "/api/stripe/webhook" });
}
