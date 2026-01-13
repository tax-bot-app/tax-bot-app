import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

// --- Stripe ---
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-12-15.clover",
});
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

// --- Supabase (Service Role: RLS回避して更新する) ---
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// priceId → plan/quota 対応表（実ID）
const PRICE_TO_PLAN: Record<string, { plan: string; monthly_quota: number }> = {
  price_1SmqJoQ3OyVaMed9QdAkDBzA: { plan: "lite", monthly_quota: 5 },
  price_1Sm8qnQ3OyVaMed9WMDOPgLZ: { plan: "standard", monthly_quota: 20 },
  price_1Smq2QQ3OyVaMed9uh5CgQfD: { plan: "enterprise", monthly_quota: 100 },
};

function planFromPrice(priceId?: string | null) {
  if (!priceId) return { plan: "free", monthly_quota: 0 };
  return PRICE_TO_PLAN[priceId] ?? { plan: "free", monthly_quota: 0 };
}

function isActiveLike(status: Stripe.Subscription.Status) {
  return status === "active" || status === "trialing";
}

async function updateUserById(params: {
  userId: string;
  plan: string;
  monthly_quota: number;
  stripe_customer_id?: string | null;
}) {
  const { userId, plan, monthly_quota, stripe_customer_id } = params;

  const { error } = await supabase
    .from("users")
    .update({
      plan,
      monthly_quota,
      stripe_customer_id: stripe_customer_id ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId);

  if (error) throw new Error(`Supabase update failed: ${error.message}`);
}

async function getUserIdFromCustomer(customerId: string) {
  const customer = (await stripe.customers.retrieve(customerId)) as Stripe.Customer;

  if (!customer || (customer as any).deleted) return null;

  const userId =
    typeof customer.metadata?.user_id === "string" ? customer.metadata.user_id : null;

  return userId;
}

async function handleSubscription(sub: Stripe.Subscription) {
  const customerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer?.id;

  if (!customerId) throw new Error("Subscription has no customer id");

  // まずは subscription.metadata.user_id（将来用）
  let userId: string | null =
    typeof sub.metadata?.user_id === "string" ? sub.metadata.user_id : null;

  // 次に customer.metadata.user_id（現メイン）
  if (!userId) {
    userId = await getUserIdFromCustomer(customerId);
  }

  if (!userId) {
    console.warn("⚠ userId not found on subscription/customer", {
      event: "subscription.*",
      subscriptionId: sub.id,
      customerId,
    });
    return; // user特定できない場合は落とさず終了（Stripe再送ループ回避）
  }

  const priceId = sub.items.data?.[0]?.price?.id ?? null;
  const mapped = planFromPrice(priceId);

  const active = isActiveLike(sub.status);

  console.log("✅ subscription event mapped", {
    subscriptionId: sub.id,
    customerId,
    userId,
    status: sub.status,
    priceId,
    mappedPlan: mapped.plan,
    mappedQuota: mapped.monthly_quota,
    willSetPlan: active ? mapped.plan : "free",
    willSetQuota: active ? mapped.monthly_quota : 0,
  });

  await updateUserById({
    userId,
    plan: active ? mapped.plan : "free",
    monthly_quota: active ? mapped.monthly_quota : 0,
    stripe_customer_id: customerId,
  });
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const userId =
    typeof session.client_reference_id === "string"
      ? session.client_reference_id
      : null;

  const customerId =
    typeof session.customer === "string" ? session.customer : null;

  const sessionId = session.id;

  console.log("✅ checkout.session.completed", {
    sessionId,
    userId,
    customerId,
    mode: session.mode,
    payment_status: session.payment_status,
  });

  // Customer に user_id を刻む（subscriptionイベントが customer から user_id を取れるようになる）
  if (userId && customerId) {
    await stripe.customers.update(customerId, {
      metadata: { user_id: userId },
    });
    console.log("✅ customer.metadata.user_id set", { customerId, userId });
  } else {
    console.warn("⚠ missing userId or customerId on checkout session", {
      sessionId,
      userId,
      customerId,
    });
  }

  // ついでに「今すぐ反映」もやる（subscription.created を待たず plan 反映）
  // ここがあると、体感が爆速になる & “永遠にfree” をさらに潰せる
  try {
    if (userId) {
      const subId =
        typeof session.subscription === "string" ? session.subscription : null;

      if (subId) {
        const sub = await stripe.subscriptions.retrieve(subId);
        await handleSubscription(sub);
      }
    }
  } catch (e: any) {
    console.warn("⚠ optional immediate sync failed (safe to ignore)", e?.message);
  }
}

export async function POST(req: Request) {
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("Missing stripe-signature", { status: 400 });

  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err: any) {
    console.error("❌ Webhook signature verification failed:", err?.message);
    return new Response(`Webhook Error: ${err?.message}`, { status: 400 });
  }

  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        await handleSubscription(sub);
        break;
      }

      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleCheckoutCompleted(session);
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err: any) {
    console.error("❌ Webhook handler failed:", err?.message);
    return new Response(`Handler Error: ${err?.message}`, { status: 500 });
  }
}
