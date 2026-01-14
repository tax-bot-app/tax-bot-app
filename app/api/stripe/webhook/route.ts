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

function planFromPriceId(priceId: string | null | undefined): { plan: string; monthly_quota: number } {
  const lite = mustEnv("STRIPE_PRICE_LITE");
  const standard = mustEnv("STRIPE_PRICE_STANDARD");
  const enterprise = mustEnv("STRIPE_PRICE_ENTERPRISE");

  if (!priceId) return { plan: "free", monthly_quota: 0 };
  if (priceId === lite) return { plan: "lite", monthly_quota: 5 };
  if (priceId === standard) return { plan: "standard", monthly_quota: 30 };
  if (priceId === enterprise) return { plan: "enterprise", monthly_quota: 100 };
  return { plan: "free", monthly_quota: 0 };
}

function adminSupabase() {
  const url = mustEnv("SUPABASE_URL");
  const serviceRole = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, serviceRole, { auth: { persistSession: false } });
}

async function upsertUserByEmail(params: {
  email: string;
  plan: string;
  monthly_quota: number;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
}) {
  const supabase = adminSupabase();

  // 既存ユーザーをemailで取得
  const { data: user, error: findErr } = await supabase
    .from("users")
    .select("id,email")
    .eq("email", params.email)
    .maybeSingle();

  if (findErr) throw findErr;

  // update（存在しないなら insert しても良いが、今の設計上は auth 登録で必ずいる前提）
  if (!user?.id) {
    // いない場合は保険でinsert（email uniqueがある前提ならOK）
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
  plan: string;
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
  if (!user?.id) return; // customer_id未紐付けなら何もしない（checkout.completedで紐付く想定）

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

export async function POST(req: Request) {
  const sig = req.headers.get("stripe-signature");
  if (!sig) return NextResponse.json({ ok: false, error: "Missing stripe-signature" }, { status: 400 });

  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: `Webhook signature verification failed: ${e?.message ?? e}` }, { status: 400 });
  }

  try {
    // 1) Checkout完了（emailが取れる最強イベント）
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      const customerId = typeof session.customer === "string" ? session.customer : null;
      const subscriptionId = typeof session.subscription === "string" ? session.subscription : null;

      // session.customer_details.email が最優先、無ければ customer を取りに行く
      let email =
        session.customer_details?.email ||
        (typeof session.customer_email === "string" ? session.customer_email : null);

      if (!email && customerId) {
        const cust = (await stripe.customers.retrieve(customerId)) as Stripe.Customer;
        email = cust.email ?? null;
      }

      if (!email) {
        // email無いとusers特定できん（ログだけ残して200で返す＝Stripeの再送地獄回避）
        console.warn("checkout.session.completed but no email", { id: session.id, customerId, subscriptionId });
        return NextResponse.json({ received: true }, { status: 200 });
      }

      // priceIdはsubscriptionから取る（checkout sessionだけでは取りにくい）
      let priceId: string | null = null;
      if (subscriptionId) {
        const sub = (await stripe.subscriptions.retrieve(subscriptionId)) as Stripe.Subscription;
        priceId = sub.items.data?.[0]?.price?.id ?? null;
      }

      const { plan, monthly_quota } = planFromPriceId(priceId);

      await upsertUserByEmail({
        email,
        plan,
        monthly_quota,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
      });

      return NextResponse.json({ received: true }, { status: 200 });
    }

    // 2) サブスク作成/更新
    if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
      const sub = event.data.object as Stripe.Subscription;

      const customerId = typeof sub.customer === "string" ? sub.customer : null;
      const subscriptionId = sub.id;
      const priceId = sub.items.data?.[0]?.price?.id ?? null;

      const active = ["active", "trialing"].includes(sub.status);
      const { plan, monthly_quota } = planFromPriceId(priceId);

      if (customerId) {
        await updateUserByCustomerId({
          stripe_customer_id: customerId,
          plan: active ? plan : "free",
          monthly_quota: active ? monthly_quota : 0,
          stripe_subscription_id: subscriptionId,
        });
      }

      return NextResponse.json({ received: true }, { status: 200 });
    }

    // 3) 解約（ここが今回の追加の肝）
    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object as Stripe.Subscription;

      const customerId = typeof sub.customer === "string" ? sub.customer : null;
      if (customerId) {
        await updateUserByCustomerId({
          stripe_customer_id: customerId,
          plan: "free",
          monthly_quota: 0,
          stripe_subscription_id: null,
        });
      }

      return NextResponse.json({ received: true }, { status: 200 });
    }

    // それ以外は握りつぶしてOK（受領だけ返す）
    return NextResponse.json({ received: true }, { status: 200 });
  } catch (e: any) {
    console.error("webhook handler error", e);
    // Stripeは5xxで再送してくる。DB一時不調の時はありがたいが、恒常バグだと地獄。
    // ここは 500 で返す（現状はバグ潰すフェーズなので再送で気づける）。
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}
