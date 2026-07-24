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
import {
  resolveCheckoutUserIdentity,
  type ResolvedCheckoutUserIdentity,
} from "../../../lib/checkoutUserIdentity";
import { selectBestStripePlan } from "../../../lib/stripePlanSelection";

export const runtime = "nodejs";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

let stripe: Stripe | null = null;

function stripeClient(): Stripe {
  stripe ??= new Stripe(mustEnv("STRIPE_SECRET_KEY"), {
    apiVersion: "2025-12-15.clover",
  });
  return stripe;
}

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

type WebhookClaim =
  | { state: "acquired"; token: string }
  | { state: "processed" }
  | { state: "in_progress" };

const WEBHOOK_PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Webhookイベントの処理権を取得する。
 * - 初回は processing で登録
 * - processed は完了済みとして終了
 * - failed または一定時間止まった processing は再取得
 * - 同時処理中は in_progress を返し、Stripeの再送に任せる
 */
async function claimWebhookEvent(event: Stripe.Event): Promise<WebhookClaim> {
  const supabase = adminSupabase();
  const now = new Date().toISOString();
  const token = crypto.randomUUID();

  const stripeCreatedAt =
    typeof event.created === "number"
      ? new Date(event.created * 1000).toISOString()
      : null;

  const { error } = await supabase.from("stripe_webhook_events").insert({
    event_id: event.id,
    event_type: event.type,
    stripe_created_at: stripeCreatedAt,
    status: "processing",
    processing_token: token,
    last_error: null,
    processed_at: null,
    updated_at: now,
  });

  if (!error) return { state: "acquired", token };

  const code = (error as { code?: string })?.code;
  if (code !== "23505") throw error;

  const { data: existing, error: findError } = await supabase
    .from("stripe_webhook_events")
    .select("status,updated_at")
    .eq("event_id", event.id)
    .single();

  if (findError) throw findError;
  if (existing.status === "processed") return { state: "processed" };

  const updatedAtMs = Date.parse(existing.updated_at);
  const isStale =
    !Number.isFinite(updatedAtMs) ||
    Date.now() - updatedAtMs >= WEBHOOK_PROCESSING_TIMEOUT_MS;

  if (existing.status === "processing" && !isStale) {
    return { state: "in_progress" };
  }

  let retryQuery = supabase
    .from("stripe_webhook_events")
    .update({
      status: "processing",
      processing_token: token,
      last_error: null,
      processed_at: null,
      updated_at: now,
    })
    .eq("event_id", event.id)
    .eq("status", existing.status);

  if (existing.updated_at) {
    retryQuery = retryQuery.eq("updated_at", existing.updated_at);
  }

  const { data: claimed, error: retryError } = await retryQuery
    .select("event_id")
    .maybeSingle();

  if (retryError) throw retryError;
  return claimed?.event_id
    ? { state: "acquired", token }
    : { state: "in_progress" };
}

async function markWebhookEventProcessed(
  eventId: string,
  token: string
): Promise<void> {
  const now = new Date().toISOString();
  const { data, error } = await adminSupabase()
    .from("stripe_webhook_events")
    .update({
      status: "processed",
      processing_token: null,
      processed_at: now,
      last_error: null,
      updated_at: now,
    })
    .eq("event_id", eventId)
    .eq("status", "processing")
    .eq("processing_token", token)
    .select("event_id")
    .maybeSingle();

  if (error) throw error;
  if (!data?.event_id) {
    throw new Error(`Webhook processing lease was lost for event ${eventId}`);
  }
}

async function markWebhookEventFailed(
  eventId: string,
  token: string,
  cause: unknown
): Promise<void> {
  const message = cause instanceof Error ? cause.message : String(cause);
  const { error } = await adminSupabase()
    .from("stripe_webhook_events")
    .update({
      status: "failed",
      processing_token: null,
      last_error: message.slice(0, 2000),
      updated_at: new Date().toISOString(),
    })
    .eq("event_id", eventId)
    .eq("status", "processing")
    .eq("processing_token", token);

  if (error) {
    console.error("[stripeWebhook] failed to persist event failure", {
      eventId,
      error: error.message,
    });
  }
}

async function processedResponse(
  eventId: string,
  token: string,
  body: Record<string, unknown> = { received: true }
) {
  await markWebhookEventProcessed(eventId, token);
  return NextResponse.json(body, { status: 200 });
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

async function writeCheckoutUser(params: {
  identity: ResolvedCheckoutUserIdentity;
  plan?: PlanKey;
  monthly_quota?: number;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
}): Promise<{ userId: string }> {
  const supabase = adminSupabase();

  const lookup = supabase
    .from("users")
    .select("id,email");
  const { data: user, error: findErr } =
    params.identity.kind === "user_id"
      ? await lookup.eq("id", params.identity.userId).maybeSingle()
      : await lookup.eq("email", params.identity.email).maybeSingle();

  if (findErr) throw findErr;

  const planFields =
    params.plan !== undefined && params.monthly_quota !== undefined
      ? {
          plan: params.plan,
          monthly_quota: params.monthly_quota,
        }
      : {};

  if (!user?.id) {
    const email = params.identity.email;
    if (!email) {
      throw new Error(
        `Checkout user ${
          params.identity.kind === "user_id"
            ? params.identity.userId
            : params.identity.email
        } was not found and has no email`
      );
    }

    const { data: inserted, error: insErr } = await supabase
      .from("users")
      .insert({
        ...(params.identity.kind === "user_id"
          ? { id: params.identity.userId }
          : {}),
        email,
        plan: params.plan ?? "free",
        monthly_quota: params.monthly_quota ?? 0,
        stripe_customer_id: params.stripe_customer_id ?? null,
        stripe_subscription_id: params.stripe_subscription_id ?? null,
      })
      .select("id")
      .single();

    if (insErr) throw insErr;
    if (!inserted?.id) throw new Error("failed to insert user (no id returned)");
    return { userId: inserted.id };
  }

  const { error: updErr } = await supabase
    .from("users")
    .update({
      ...planFields,
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
  const debug = process.env.DEBUG_STRIPE_PLAN_SYNC === "1";

  const subs = await stripeClient().subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 100,
  });

  const subscriptions = subs.data.map((subscription) => {
    const timing = subscription as Stripe.Subscription & {
      current_period_end?: number;
    };

    return {
      id: subscription.id,
      status: subscription.status,
      priceIds: (subscription.items?.data ?? []).map(
        (item) => item.price?.id ?? null
      ),
      currentPeriodEnd: Number(timing.current_period_end ?? 0),
      created: Number(subscription.created ?? 0),
    };
  });

  if (debug) {
    console.log("[planSync] subs", JSON.stringify({
      customerId,
      total: subs.data.length,
      statuses: subs.data.map((s) => s.status),
      candidates: subscriptions.filter((subscription) =>
        ["active", "trialing"].includes(subscription.status)
      ),
    }));
  }

  const selection = selectBestStripePlan(subscriptions);

  if (selection.kind === "free") {
    const free = getPlan("free");
    return {
      plan: "free",
      monthly_quota: free.monthlyQuota,
      subscription_id: null,
    };
  }

  if (selection.kind === "unresolved") {
    if (debug) {
      console.warn("[planSync] unresolved active subscriptions", JSON.stringify({
        customerId,
        subscriptionIds: selection.activeSubscriptionIds,
      }));
    }
    throw new Error(
      `Active subscriptions exist but no recognized price IDs for customer ${customerId}`
    );
  }

  const plan = selection.plan;
  const planDef = getPlan(plan);

  if (debug) {
    console.log("[planSync] best", JSON.stringify({
      customerId,
      picked: {
        subId: selection.subscriptionId,
        plan,
        sortOrder: planDef.sortOrder,
      },
    }));
  }

  return {
    plan,
    monthly_quota: planDef.monthlyQuota,
    subscription_id: selection.subscriptionId,
  };
}

async function syncUserPlanByCustomerId(customerId: string): Promise<{
  userId: string;
  monthly_quota: number;
} | null> {
  console.log("[planSync] start", JSON.stringify({ customerId }));

  const best = await computeBestPlanForCustomer(customerId);

  console.log("[planSync] resolved", JSON.stringify({
    customerId,
    plan: best.plan,
    monthly_quota: best.monthly_quota,
    subscription_id: best.subscription_id,
  }));

  const updated = await updateUserByCustomerId({
    stripe_customer_id: customerId,
    plan: best.plan,
    monthly_quota: best.monthly_quota,
    stripe_subscription_id: best.subscription_id,
  });

  if (!updated?.userId) {
    console.warn("[planSync] user not found for customer", { customerId });
    return null;
  }

  await syncUsageCurrentMonth({
    userId: updated.userId,
    monthly_quota: best.monthly_quota,
  });

  console.log("[planSync] applied", JSON.stringify({
    customerId,
    userId: updated.userId,
    monthly_quota: best.monthly_quota,
  }));

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
    event = stripeClient().webhooks.constructEvent(
      rawBody,
      sig,
      mustEnv("STRIPE_WEBHOOK_SECRET"),
    );
  } catch (e: unknown) {
    return NextResponse.json(
      {
        ok: false,
        error: `Webhook signature verification failed: ${errorMessage(e)}`,
      },
      { status: 400 }
    );
  }

  // 副作用を始める前に、このイベントの処理権を取得する
  let processingToken: string;
  try {
    const claim = await claimWebhookEvent(event);
    if (claim.state === "processed") {
      return NextResponse.json(
        { received: true, deduped: true },
        { status: 200 }
      );
    }
    if (claim.state === "in_progress") {
      return NextResponse.json(
        { ok: false, retry: true, error: "Webhook event is already processing" },
        { status: 503 }
      );
    }
    processingToken = claim.token;
  } catch (e: unknown) {
    console.error("webhook claim failed", e);
    return NextResponse.json(
      { ok: false, error: errorMessage(e) },
      { status: 500 }
    );
  }

  try {
    console.log("[stripeWebhook] received", JSON.stringify({
      id: event.id,
      type: event.type,
      created: event.created,
    }));

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

      console.log("[stripeWebhook] checkout.session.completed", JSON.stringify({
        sessionId: session.id,
        customerId,
        subscriptionId,
        email,
      }));


      if (!email && customerId) {
        const cust = (await stripeClient().customers.retrieve(
          customerId
        )) as Stripe.Customer;
        email = cust.email ?? null;
      }

      const identity = resolveCheckoutUserIdentity({
        metadataUserId: session.metadata?.user_id,
        email,
      });

      if (identity.kind === "unresolved") {
        throw new Error(
          `Checkout user identity could not be resolved for session ${session.id}: ${identity.reason}`
        );
      }

      if (identity.kind === "legacy_email") {
        console.warn("[stripeWebhook] using legacy email identity", {
          id: session.id,
          customerId,
          subscriptionId,
        });
      }

      // 一旦このsubscriptionのpriceIdから暫定プランを入れる（紐付け優先）
      let priceId: string | null = null;
      if (subscriptionId) {
        const sub = (await stripeClient().subscriptions.retrieve(
          subscriptionId
        )) as Stripe.Subscription;
        priceId = sub.items.data?.[0]?.price?.id ?? null;
      }

      const planDef = getPlanByPriceId(priceId);

      // ✅ unknown price は free に丸めて users.plan を壊さない
      if (planDef) {
        const tempPlanKey: PlanKey = normalizePlanKey(planDef.key);
        const tempPlan = getPlan(tempPlanKey);

        const { userId } = await writeCheckoutUser({
          identity,
          plan: tempPlanKey,
          monthly_quota: tempPlan.monthlyQuota,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
        });

        // ✅ 暫定usage同期は plan 解決できた時だけ
        await syncUsageCurrentMonth({
          userId,
          monthly_quota: tempPlan.monthlyQuota,
        });
      } else {
        // Price不明でも、認証済みuser_idとの紐付けだけは保持する。
        // planは変更せず、最後の正同期を失敗させて再送対象にする。
        await writeCheckoutUser({
          identity,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
        });

        console.error("[planSync] unknown priceId on checkout.session.completed", {
          identityKind: identity.kind,
          customerId,
          subscriptionId,
          priceId,
        });
      }

      // ✅ 最後に“正”同期（複数サブスクでも最強プランへ）
      if (customerId) {
        await syncUserPlanByCustomerId(customerId);
      }
      return processedResponse(event.id, processingToken);
    }

    // 2) サブスク作成/更新 → customer全体を同期（users更新→usage同期まで含む）
        if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated"
    ) {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === "string" ? sub.customer : null;

      console.log("[stripeWebhook] subscription.event", JSON.stringify({
        type: event.type,
        subId: sub.id,
        customerId,
        status: sub.status,
        prices: (sub.items?.data ?? []).map((it) => it.price?.id ?? null),
      }));

      if (customerId) {
        await syncUserPlanByCustomerId(customerId);
      }

      return processedResponse(event.id, processingToken);
    }

    // 3) 解約（deleted） → free固定にせず、残りサブスクで再計算（users更新→usage同期まで含む）
        if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === "string" ? sub.customer : null;

      console.log("[stripeWebhook] subscription.event", JSON.stringify({
        type: event.type,
        subId: sub.id,
        customerId,
        status: sub.status,
        prices: (sub.items?.data ?? []).map((it) => it.price?.id ?? null),
      }));

      if (customerId) {
        try {
          await syncUserPlanByCustomerId(customerId);
        } catch (e) {
          console.warn("[planSync] first deleted-sync failed, retrying once", {
            customerId,
            error: e instanceof Error ? e.message : String(e),
          });

          await new Promise((r) => setTimeout(r, 1500));
          await syncUserPlanByCustomerId(customerId);
        }
      }

      return processedResponse(event.id, processingToken);
    }

    return processedResponse(event.id, processingToken);
  } catch (e: unknown) {
    console.error("webhook handler error", e);
    await markWebhookEventFailed(event.id, processingToken, e);
    return NextResponse.json(
      { ok: false, error: errorMessage(e) },
      { status: 500 }
    );
  }
}
