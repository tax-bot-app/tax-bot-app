// app/api/create-checkout/route.ts
import { NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

import { getPriceId, type PlanKey } from "../../lib1/planMaster";

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const stripe = new Stripe(mustEnv("STRIPE_SECRET_KEY"), {
  apiVersion: "2025-12-15.clover",
});

type ReqBody = { plan?: PlanKey };

function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function adminSupabase() {
  const url = mustEnv("SUPABASE_URL");
  const serviceRole = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, serviceRole, { auth: { persistSession: false } });
}

export async function POST(req: Request) {
  try {
    const { plan } = (await req.json().catch(() => ({}))) as ReqBody;

    // free は checkout 作らない
    if (!plan || plan === "free") {
      return NextResponse.json({ ok: false, error: "invalid plan" }, { status: 400 });
    }

    // ログイン必須
    const token = bearerToken(req);
    if (!token) {
      return NextResponse.json({ ok: false, error: "missing auth" }, { status: 401 });
    }

    const db = adminSupabase();
    const { data: userRes, error: userErr } = await db.auth.getUser(token);
    if (userErr || !userRes?.user?.id) {
      return NextResponse.json({ ok: false, error: "invalid session" }, { status: 401 });
    }

    const uid = userRes.user.id;
    const { data: urow, error: uErr } = await db
      .from("users")
      .select("plan,stripe_customer_id")
      .eq("id", uid)
      .maybeSingle();

    if (uErr) throw uErr;

    const currentPlan = String(urow?.plan ?? "free").toLowerCase();

    // ✅ free以外は新規checkout禁止
    if (currentPlan !== "free") {
      return NextResponse.json(
        { ok: false, error: "すでに有効なプランがあります。プラン変更は別導線で行ってください。" },
        { status: 409 }
      );
    }

    const existingCustomerId = urow?.stripe_customer_id ? String(urow.stripe_customer_id) : null;

    // ✅ Stripe側でも有効契約を確認（DBズレ保険）
    if (existingCustomerId) {
      const subs = await stripe.subscriptions.list({
        customer: existingCustomerId,
        status: "all",
        limit: 20,
      });

      const activeLike = subs.data.find((s) =>
        ["trialing", "active", "past_due", "unpaid"].includes(s.status)
      );

      if (activeLike) {
        return NextResponse.json(
          { ok: false, error: "すでにStripe上で有効な契約があります。重複決済を防ぐため停止しました。" },
          { status: 409 }
        );
      }
    }

    const priceId = getPriceId(plan);
    const origin = req.headers.get("origin") ?? mustEnv("NEXT_PUBLIC_SITE_URL");

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      ...(existingCustomerId
        ? { customer: existingCustomerId }
        : { customer_email: userRes.user.email ?? undefined }),
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/`,
      metadata: {
        user_id: uid,
        plan,
      },
    });

    const sessCustomerId = typeof session.customer === "string" ? session.customer : null;
    if (sessCustomerId && !urow?.stripe_customer_id) {
      await db
        .from("users")
        .update({
          stripe_customer_id: sessCustomerId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", uid);
    }

    return NextResponse.json({ ok: true, url: session.url }, { status: 200 });
  } catch (e: any) {
    console.error("create-checkout error:", e);
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}