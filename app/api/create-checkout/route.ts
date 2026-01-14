import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-12-15.clover",
});

const PRICE_ID_BY_PLAN: Record<string, string> = {
  lite: process.env.STRIPE_PRICE_LITE!,
  standard: process.env.STRIPE_PRICE_STANDARD!,
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE!,
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
      return Response.json({ ok: false, error: `missing priceId for plan=${plan}` }, { status: 500 });
    }

    const supabaseUrl = process.env.SUPABASE_URL!;
    const supabaseAnon = process.env.SUPABASE_ANON_KEY!;
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

    // Stripe customer（なければ作成）
    const customers = await stripe.customers.search({
      query: `email:'${email.replace(/'/g, "\\'")}'`,
      limit: 1,
    });

    const customer =
      customers.data[0] ??
      (await stripe.customers.create({
        email,
        metadata: { supabase_user_id: userData.user.id },
      }));

    const appUrl = mustAppUrl(req);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customer.id,
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${appUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/chat`,
      // webhook側で使うなら残しとくと便利
      metadata: {
        plan,
        supabase_user_id: userData.user.id,
        email,
      },
    });

    return Response.json({ ok: true, url: session.url }, { status: 200 });
  } catch (e: any) {
    console.error("create-checkout error:", e);
    return Response.json(
      { ok: false, error: e?.message ?? "internal error" },
      { status: 500 }
    );
  }
}
