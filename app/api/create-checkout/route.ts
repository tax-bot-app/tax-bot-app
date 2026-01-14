// app/api/create-checkout/route.ts
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const stripe = new Stripe(mustEnv("STRIPE_SECRET_KEY"), {
  apiVersion: "2025-12-15.clover",
});

const PRICE_ID_BY_PLAN: Record<string, string> = {
  lite: mustEnv("STRIPE_PRICE_LITE"),
  standard: mustEnv("STRIPE_PRICE_STANDARD"),
  enterprise: mustEnv("STRIPE_PRICE_ENTERPRISE"),
};

function getBearerToken(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1] ?? null;
}

function mustAppUrl(req: Request) {
  // ✅ 推奨：必ず本番URLに戻す（Previewドメイン事故を防ぐ）
  const envUrl = process.env.APP_URL?.trim();
  if (envUrl) return envUrl.replace(/\/$/, "");

  // 保険（APP_URL未設定でも動くようにするが、Preview事故が起きる）
  const origin = req.headers.get("origin") || "";
  return origin.replace(/\/$/, "");
}

function safeStripeQueryEmail(email: string) {
  // Stripe search query用にシングルクォートをエスケープ
  return email.replace(/'/g, "\\'");
}

async function findOrCreateCustomer(email: string, supabaseUserId: string) {
  const customers = await stripe.customers.search({
    query: `email:'${safeStripeQueryEmail(email)}'`,
    limit: 1,
  });

  const found = customers.data[0];
  if (found) return found;

  return await stripe.customers.create({
    email,
    metadata: { supabase_user_id: supabaseUserId },
  });
}

async function findActiveOrTrialingSubscription(customerId: string) {
  const subs = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 20,
  });

  return subs.data.find((s) => s.status === "active" || s.status === "trialing") ?? null;
}

async function createPortalUrl(customerId: string, returnUrl: string) {
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return session.url;
}

export async function POST(req: Request) {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return Response.json({ ok: false, error: "missing bearer token" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const plan = String(body?.plan ?? "").toLowerCase();

    if (!["lite", "standard", "enterprise"].includes(plan)) {
      return Response.json({ ok: false, error: "invalid plan" }, { status: 400 });
    }

    const priceId = PRICE_ID_BY_PLAN[plan];
    if (!priceId) {
      return Response.json(
        { ok: false, error: `missing priceId for plan=${plan}` },
        { status: 500 }
      );
    }

    const supabaseUrl = mustEnv("SUPABASE_URL");
    const supabaseAnon = mustEnv("SUPABASE_ANON_KEY");
    const supabase = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false },
    });

    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    const email = userData.user.email;
    if (!email) {
      return Response.json({ ok: false, error: "no email" }, { status: 400 });
    }

    const appUrl = mustAppUrl(req);

    // ✅ Stripe customer（なければ作成）
    const customer = await findOrCreateCustomer(email, userData.user.id);

    // ✅ 二重契約防止：すでにactive/trialingがあればCheckoutは作らない
    const activeSub = await findActiveOrTrialingSubscription(customer.id);
    if (activeSub) {
      const portalUrl = await createPortalUrl(customer.id, `${appUrl}/chat`);
      return Response.json(
        {
          ok: true,
          mode: "portal",
          url: portalUrl,
          reason: "already_subscribed",
          subscription_status: activeSub.status,
        },
        { status: 200 }
      );
    }

    // ✅ ここまで来たら初回（または解約済）なのでCheckout作成OK
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customer.id,
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${appUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/chat`,
      metadata: {
        plan,
        supabase_user_id: userData.user.id,
        email,
      },
    });

    return Response.json({ ok: true, mode: "checkout", url: session.url }, { status: 200 });
  } catch (e: any) {
    console.error("create-checkout error:", e);
    return Response.json({ ok: false, error: e?.message ?? "internal error" }, { status: 500 });
  }
}
