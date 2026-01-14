// app/api/stripe/webhook/route.ts
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const stripe = new Stripe(mustEnv("STRIPE_SECRET_KEY"), {
  apiVersion: "2025-12-15.clover",
});

const webhookSecret = mustEnv("STRIPE_WEBHOOK_SECRET");

type Plan = "free" | "lite" | "standard" | "enterprise";

function planRank(plan: Plan): number {
  switch (plan) {
    case "enterprise":
      return 3;
    case "standard":
      return 2;
    case "lite":
      return 1;
    default:
      return 0;
  }
}

function quotaByPlan(plan: Plan): number {
  switch (plan) {
    case "enterprise":
      return 100;
    case "standard":
      return 30;
    case "lite":
      return 5;
    default:
      return 0;
  }
}

function planFromPriceId(priceId: string | null | undefined): Plan {
  const lite = mustEnv("STRIPE_PRICE_LITE");
  const standard = mustEnv("STRIPE_PRICE_STANDARD");
  const enterprise = mustEnv("STRIPE_PRICE_ENTERPRISE");

  if (!priceId) return "free";
  if (priceId === lite) return "lite";
  if (priceId === standard) return "standard";
  if (priceId === enterprise) return "enterprise";
  return "free";
}

function adminSupabase() {
  const url = mustEnv("SUPABASE_URL");
  const serviceRole = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, serviceRole, { auth: { persistSession: false } });
}

async function upsertUserByEmail(params: {
  email: string;
  plan: Plan;
  monthly_quota: number;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
}) {
  const supabase = adminSupabase();

  const { data: user, error: findErr } = await supabase
    .from("users")
    .select("id,email")
    .eq("email", params.email)
    .maybeSingle();

  if (findErr) throw findErr;

  if (!user?.id) {
    const { error: insErr } = await supabase.from("users").insert({
      email: params.email,
      plan: params.plan,
      monthly_quota: params.monthly_quota,
      stripe_customer_id: params.stripe_customer_id ?? null,
      stripe_subscription_id: params.stripe_subscription_id ?? null,
    });
    if (insErr) throw insErr;
    return;
  }

  const { error: updErr } = await supabase
    .from("users")
    .update({
      plan: params.plan,
      monthly_quota: params.monthly_quota,
      stripe_customer_id: params.stripe_customer_id ?? null,
      stripe_subscription_id: params.stripe_subscription_id ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", user.id);

  if (updErr) throw updErr;
}

async function updateUserByCustomerId(params: {
  stripe_customer_id: string;
  plan: Plan;
  monthly_quota: number;
  stripe_subscription_id?: string | null;
}) {
  const supabase = adminSupabase();

  const { data: user, error: findErr } = await supabase
    .from("users")
    .select("id")
    .eq("stripe_customer_id", params.stripe_customer_id)
    .maybeSingle();

  if (findErr) throw findErr;
  if (!user?.id) return;

  const { error: updErr } = await supabase
    .from("users")
    .update({
      plan: params.plan,
      monthly_quota: params.monthly_quota,
      stripe_subscription_id: params.stripe_subscription_id ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", user.id);

  if (updErr) throw updErr;
}

/**
 * ✅ 複数サブスク対応の“正”同期
 * - customer の全サブスクを見て「今有効な中で最強プラン」を決める
 * - active/trialing は有効（cancel_at_period_end=true でも期間中はstatus=activeなのでOK）
 * - items が複数でも、その中で最強 price を採用
 */
async function computeBestPlanForCustomer(customerId: string): Promise<{
  plan: Plan;
  monthly_quota: number;
  subscription_id: string | null;
}> {
  // Stripeのlistはページングあるけど、通常ここまで多くならない想定で first 100
  const subs = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 100,
  });

  // 有効扱い候補
  const candidates = subs.data.filter((s) => ["active", "trialing"].includes(s.status));

  if (candidates.length === 0) {
    return { plan: "free", monthly_quota: 0, subscription_id: null };
  }

  // 各サブスクごとに「そのサブスク内の最強プラン」を算出
  const scored = candidates.map((s) => {
    let best: Plan = "free";
    for (const item of s.items.data ?? []) {
      const p = planFromPriceId(item.price?.id ?? null);
      if (planRank(p) > planRank(best)) best = p;
    }
    return {
      sub: s,
      bestPlanInSub: best,
      rank: planRank(best),
      // 期間末が未来でも status=active なら候補、tie-breakで period_end を使う
      periodEnd: s.current_period_end ?? 0,
    };
  });

  // 最強プラン > 同点なら period_end が一番未来 > それでも同点なら最新(created)優先
  scored.sort((a, b) => {
    if (b.rank !== a.rank) return b.rank - a.rank;
    if ((b.periodEnd ?? 0) !== (a.periodEnd ?? 0)) return (b.periodEnd ?? 0) - (a.periodEnd ?? 0);
    return (b.sub.created ?? 0) - (a.sub.created ?? 0);
  });

  const best = scored[0];
  const plan = best.bestPlanInSub;
  return { plan, monthly_quota: quotaByPlan(plan), subscription_id: best.sub.id };
}

async function syncUserPlanByCustomerId(customerId: string) {
  const best = await computeBestPlanForCustomer(customerId);
  await updateUserByCustomerId({
    stripe_customer_id: customerId,
    plan: best.plan,
    monthly_quota: best.monthly_quota,
    stripe_subscription_id: best.subscription_id,
  });
}

export async function POST(req: Request) {
  const sig = req.headers.get("stripe-signature");
  if (!sig) return NextResponse.json({ ok: false, error: "Missing stripe-signature" }, { status: 400 });

  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: `Webhook signature verification failed: ${e?.message ?? e}` },
      { status: 400 }
    );
  }

  try {
    // 1) Checkout完了（emailが取れる最強イベント）
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      const customerId = typeof session.customer === "string" ? session.customer : null;
      const subscriptionId = typeof session.subscription === "string" ? session.subscription : null;

      let email =
        session.customer_details?.email ||
        (typeof session.customer_email === "string" ? session.customer_email : null);

      if (!email && customerId) {
        const cust = (await stripe.customers.retrieve(customerId)) as Stripe.Customer;
        email = cust.email ?? null;
      }

      if (!email) {
        console.warn("checkout.session.completed but no email", {
          id: session.id,
          customerId,
          subscriptionId,
        });
        return NextResponse.json({ received: true }, { status: 200 });
      }

      // まずは紐付けを確実に（customerId / subscriptionId を users に保存）
      // plan は “一旦” subscriptionId の内容で入れてOK（後でsyncで上書きする）
      let priceId: string | null = null;
      if (subscriptionId) {
        const sub = (await stripe.subscriptions.retrieve(subscriptionId)) as Stripe.Subscription;
        priceId = sub.items.data?.[0]?.price?.id ?? null;
      }
      const tempPlan = planFromPriceId(priceId);
      await upsertUserByEmail({
        email,
        plan: tempPlan,
        monthly_quota: quotaByPlan(tempPlan),
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
      });

      // ✅ 最後に“正”同期（複数サブスクでも最強プランへ）
      if (customerId) {
        await syncUserPlanByCustomerId(customerId);
      }

      return NextResponse.json({ received: true }, { status: 200 });
    }

    // 2) サブスク作成/更新 → ✅ 毎回 customer 全体を同期
    if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === "string" ? sub.customer : null;

      if (customerId) {
        await syncUserPlanByCustomerId(customerId);
      }

      return NextResponse.json({ received: true }, { status: 200 });
    }

    // 3) 解約（deleted） → ✅ free固定にせず、残りサブスクで再計算
    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === "string" ? sub.customer : null;

      if (customerId) {
        await syncUserPlanByCustomerId(customerId);
      }

      return NextResponse.json({ received: true }, { status: 200 });
    }

    return NextResponse.json({ received: true }, { status: 200 });
  } catch (e: any) {
    console.error("webhook handler error", e);
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}
