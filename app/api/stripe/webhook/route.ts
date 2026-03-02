// app/api/stripe/webhook/route.ts
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import {
  getPlan,
  getPlanByPriceId,
  normalizePlanKey,
  type PlanKey,
} from "../../../lib1/planMaster";

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

function adminSupabase() {
  const url = mustEnv("SUPABASE_URL");
  const serviceRole = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, serviceRole, { auth: { persistSession: false } });
}

function currentMonthKey(): string {
  // JSTで "YYYY-MM" を作る（UTCズレ事故防止）
  const d = new Date();
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000); // +09:00
  return jst.toISOString().slice(0, 7);
}

/**
 * ✅ 冪等性チェック
 * - stripe_webhook_events.event_id を primary key にして「先にinsert」
 * - すでにあれば 23505(duplicate) で即return
 */
async function ensureIdempotency(event: Stripe.Event): Promise<{
  isDuplicate: boolean;
}> {
  const supabase = adminSupabase();

  const stripeCreatedAt =
    typeof event.created === "number"
      ? new Date(event.created * 1000).toISOString()
      : null;

  const { error } = await supabase.from("stripe_webhook_events").insert({
    event_id: event.id,
    event_type: event.type,
    stripe_created_at: stripeCreatedAt,
  });

  if (!error) return { isDuplicate: false };

  // Postgres unique violation
  const code = (error as any)?.code;
  if (code === "23505") return { isDuplicate: true };

  throw error;
}

/**
 * ✅ users.monthly_quota に合わせて usage.limit_talks を当月分だけ同期
 * - PK (user_id, month) があるので upsert が安全に使える
 * - used_talks / used は絶対に触らない（上書き事故防止）
 */
async function syncUsageCurrentMonth(params: {
  userId: string;
  monthly_quota: number;
}) {
  const supabase = adminSupabase();
  const month = currentMonthKey();

  const { error } = await supabase
    .from("usage")
    .upsert(
      {
        user_id: params.userId,
        month,
        limit_talks: params.monthly_quota,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,month" }
    );

  if (error) throw error;
}

async function upsertUserByEmail(params: {
  email: string;
  plan: PlanKey;
  monthly_quota: number;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
}): Promise<{ userId: string }> {
  const supabase = adminSupabase();

  const { data: user, error: findErr } = await supabase
    .from("users")
    .select("id,email")
    .eq("email", params.email)
    .maybeSingle();

  if (findErr) throw findErr;

  // insert
  if (!user?.id) {
    const { data: inserted, error: insErr } = await supabase
      .from("users")
      .insert({
        email: params.email,
        plan: params.plan,
        monthly_quota: params.monthly_quota,
        stripe_customer_id: params.stripe_customer_id ?? null,
        stripe_subscription_id: params.stripe_subscription_id ?? null,
      })
      .select("id")
      .single();

    if (insErr) throw insErr;
    if (!inserted?.id) throw new Error("failed to insert user (no id returned)");
    return { userId: inserted.id };
  }

  // update
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

  return { userId: user.id };
}

async function updateUserByCustomerId(params: {
  stripe_customer_id: string;
  plan: PlanKey;
  monthly_quota: number;
  stripe_subscription_id?: string | null;
}): Promise<{ userId: string } | null> {
  const supabase = adminSupabase();

  const { data: user, error: findErr } = await supabase
    .from("users")
    .select("id")
    .eq("stripe_customer_id", params.stripe_customer_id)
    .maybeSingle();

  if (findErr) throw findErr;
  if (!user?.id) return null;

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

  return { userId: user.id };
}

/**
 * ✅ 複数サブスク対応の“正”同期
 * - customer の全サブスクを見て「今有効な中で最強プラン」を決める
 */
async function computeBestPlanForCustomer(customerId: string): Promise<{
  plan: PlanKey;
  monthly_quota: number;
  subscription_id: string | null;
}> {
  const debug = process.env.DEBUG_STRIPE_PLAN_SYNC === "1";//デバック用

  const subs = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 100,
  });

  const candidates = subs.data.filter((s) =>
    ["active", "trialing"].includes(s.status)
  );

  if (debug) {
    console.log("[planSync] subs", JSON.stringify({
      customerId,
      total: subs.data.length,
      statuses: subs.data.map((s) => s.status),
      candidates: candidates.map((s) => ({
        id: s.id,
        status: s.status,
        prices: (s.items?.data ?? []).map((it) => it.price?.id ?? null),
      })),
    }));
  }

  if (candidates.length === 0) {
    const free = getPlan("free");
    return {
      plan: "free",
      monthly_quota: free.monthlyQuota,
      subscription_id: null,
    };
  }

  const scored = candidates.map((s) => {
    let bestKey: PlanKey = "free";

    for (const item of s.items.data ?? []) {
      const pid = item.price?.id ?? null;
      const planDef = getPlanByPriceId(pid);
if (!planDef) continue;
const key = normalizePlanKey(planDef.key);

      const cur = getPlan(bestKey);
      const next = getPlan(key);
      if (next.sortOrder > cur.sortOrder) bestKey = key;
    }

    const anyS = s as any;
    const periodEnd = Number(anyS.current_period_end ?? 0);
    const created = Number(anyS.created ?? 0);

    return {
      sub: s,
      bestKey,
      sortOrder: getPlan(bestKey).sortOrder,
      periodEnd,
      created,
    };
  });

  scored.sort((a, b) => {
    if (b.sortOrder !== a.sortOrder) return b.sortOrder - a.sortOrder;
    if (b.periodEnd !== a.periodEnd) return b.periodEnd - a.periodEnd;
    return b.created - a.created;
  });

  const best = scored[0];
  const plan = best.bestKey;
  const planDef = getPlan(plan);

  if (debug) {
    console.log("[planSync] best", JSON.stringify({
      customerId,
      picked: { subId: best.sub.id, plan, sortOrder: best.sortOrder },
    }));
  }
  return {
    plan,
    monthly_quota: planDef.monthlyQuota,
    subscription_id: best.sub.id,
  };
}

async function syncUserPlanByCustomerId(customerId: string): Promise<{
  userId: string;
  monthly_quota: number;
} | null> {
  const best = await computeBestPlanForCustomer(customerId);

  const updated = await updateUserByCustomerId({
    stripe_customer_id: customerId,
    plan: best.plan,
    monthly_quota: best.monthly_quota,
    stripe_subscription_id: best.subscription_id,
  });

  if (!updated?.userId) return null;

  // ✅ users が確定した直後に usage を当月分だけ同期
  await syncUsageCurrentMonth({
    userId: updated.userId,
    monthly_quota: best.monthly_quota,
  });

  return { userId: updated.userId, monthly_quota: best.monthly_quota };
}

export async function POST(req: Request) {
  const sig = req.headers.get("stripe-signature");
  if (!sig) {
    return NextResponse.json(
      { ok: false, error: "Missing stripe-signature" },
      { status: 400 }
    );
  }

  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (e: any) {
    return NextResponse.json(
      {
        ok: false,
        error: `Webhook signature verification failed: ${e?.message ?? e}`,
      },
      { status: 400 }
    );
  }

  // ✅ ここが肝：先に冪等性チェック
  try {
    const { isDuplicate } = await ensureIdempotency(event);
    if (isDuplicate) {
      // Stripe の再送・二重到達を “何もせず成功” にする
      return NextResponse.json(
        { received: true, deduped: true },
        { status: 200 }
      );
    }
  } catch (e: any) {
    console.error("idempotency check failed", e);
    return NextResponse.json(
      { ok: false, error: e?.message ?? String(e) },
      { status: 500 }
    );
  }

  try {
    // 1) Checkout完了（emailが取れる最強イベント）
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      const customerId =
        typeof session.customer === "string" ? session.customer : null;
      const subscriptionId =
        typeof session.subscription === "string" ? session.subscription : null;

      let email =
        session.customer_details?.email ||
        (typeof session.customer_email === "string"
          ? session.customer_email
          : null);

      if (!email && customerId) {
        const cust = (await stripe.customers.retrieve(
          customerId
        )) as Stripe.Customer;
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

      // 一旦このsubscriptionのpriceIdから暫定プランを入れる（紐付け優先）
      let priceId: string | null = null;
      if (subscriptionId) {
        const sub = (await stripe.subscriptions.retrieve(
          subscriptionId
        )) as Stripe.Subscription;
        priceId = sub.items.data?.[0]?.price?.id ?? null;
      }

      const planDef = getPlanByPriceId(priceId);
      const tempPlanKey: PlanKey = normalizePlanKey(planDef?.key);
      const tempPlan = getPlan(tempPlanKey);

      // ✅ users を upsert（この時点で userId を確実に取得）
      const { userId } = await upsertUserByEmail({
        email,
        plan: tempPlanKey,
        monthly_quota: tempPlan.monthlyQuota,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
      });

      /// ✅ 暫定usage同期は「planDefが取れた時だけ」
      // 値下げ切替などで旧priceが来ると tempPlanKey が free になり得るため、0同期事故を防ぐ
      if (planDef) {
        await syncUsageCurrentMonth({
          userId,
          monthly_quota: tempPlan.monthlyQuota,
        });
      }

      // ✅ 最後に“正”同期（複数サブスクでも最強プランへ）→ ここでも usage 同期される
      if (customerId) {
        await syncUserPlanByCustomerId(customerId);
      }

      return NextResponse.json({ received: true }, { status: 200 });
    }

    // 2) サブスク作成/更新 → customer全体を同期（users更新→usage同期まで含む）
    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated"
    ) {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === "string" ? sub.customer : null;

      if (customerId) {
        await syncUserPlanByCustomerId(customerId);
      }

      return NextResponse.json({ received: true }, { status: 200 });
    }

    // 3) 解約（deleted） → free固定にせず、残りサブスクで再計算（users更新→usage同期まで含む）
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
    return NextResponse.json(
      { ok: false, error: e?.message ?? String(e) },
      { status: 500 }
    );
  }
}
