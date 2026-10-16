import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import Stripe from "stripe";

import { singleCheckoutIdempotencyKey } from "../../lib/singleCheckoutIdempotency";
import {
  getSinglePurchasePriceId,
  isSinglePurchaseKey,
} from "../../lib/singlePurchase";
import { siteOrigin } from "../../lib/siteOrigin";
import {
  stripeRouteErrorDiagnostic,
  stripeRouteErrorMessage,
} from "../../lib/stripeRouteError";

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

let stripe: Stripe | null = null;

function stripeClient(): Stripe {
  stripe ??= new Stripe(mustEnv("STRIPE_SECRET_KEY"), {
    apiVersion: "2025-12-15.clover",
  });
  return stripe;
}

function adminSupabase() {
  return createClient(
    mustEnv("SUPABASE_URL"),
    mustEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } }
  );
}

function bearerToken(req: Request): string | null {
  const header =
    req.headers.get("authorization") || req.headers.get("Authorization");
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as {
      purchase?: unknown;
      attemptId?: unknown;
    } | null;
    const purchase = body?.purchase;
    const attemptId =
      typeof body?.attemptId === "string" ? body.attemptId.trim() : "";

    if (!isSinglePurchaseKey(purchase) || !isUuid(attemptId)) {
      return NextResponse.json(
        { ok: false, error: "invalid purchase" },
        { status: 400 }
      );
    }

    const token = bearerToken(req);
    if (!token) {
      return NextResponse.json(
        { ok: false, error: "missing auth" },
        { status: 401 }
      );
    }

    const db = adminSupabase();
    const { data: userRes, error: userError } = await db.auth.getUser(token);
    if (userError || !userRes.user?.id) {
      return NextResponse.json(
        { ok: false, error: "invalid session" },
        { status: 401 }
      );
    }

    const userId = userRes.user.id;
    const { data: userRow, error: lookupError } = await db
      .from("users")
      .select("stripe_customer_id")
      .eq("id", userId)
      .maybeSingle();
    if (lookupError) throw lookupError;

    const priceId = getSinglePurchasePriceId(purchase);
    const existingCustomerId = userRow?.stripe_customer_id
      ? String(userRow.stripe_customer_id)
      : null;
    const siteUrl = siteOrigin();
    const metadata = {
      checkout_kind: "single_credit",
      user_id: userId,
      single_purchase: purchase,
    };

    const session = await stripeClient().checkout.sessions.create(
      {
        mode: "payment",
        ...(existingCustomerId
          ? { customer: existingCustomerId }
          : { customer_email: userRes.user.email ?? undefined }),
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${siteUrl}/success?session_id={CHECKOUT_SESSION_ID}&purchase=single`,
        cancel_url: `${siteUrl}/?plans=1`,
        metadata,
        payment_intent_data: { metadata },
      },
      {
        idempotencyKey: singleCheckoutIdempotencyKey({
          userId,
          purchase,
          priceId,
          attemptId,
        }),
      }
    );

    const sessionCustomerId =
      typeof session.customer === "string" ? session.customer : null;
    if (sessionCustomerId && !userRow?.stripe_customer_id) {
      const { error: updateError } = await db
        .from("users")
        .update({
          stripe_customer_id: sessionCustomerId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", userId);
      if (updateError) throw updateError;
    }

    return NextResponse.json({ ok: true, url: session.url }, { status: 200 });
  } catch (error: unknown) {
    console.error(
      "[stripe-single-checkout:failed]",
      stripeRouteErrorDiagnostic(error)
    );
    return NextResponse.json(
      { ok: false, error: stripeRouteErrorMessage("checkout") },
      { status: 500 }
    );
  }
}

