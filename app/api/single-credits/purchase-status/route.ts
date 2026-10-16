import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import Stripe from "stripe";

import { subscriptionConversionId } from "../../../lib/openaiAdsSubscription";
import { resolveSinglePurchaseByPriceId } from "../../../lib/singlePurchase";
import { stripeRouteErrorDiagnostic } from "../../../lib/stripeRouteError";

export const runtime = "nodejs";

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

export async function POST(req: Request) {
  try {
    const token = bearerToken(req);
    if (!token) {
      return NextResponse.json({ confirmed: false }, { status: 401 });
    }

    const db = adminSupabase();
    const { data: userResult, error: userError } = await db.auth.getUser(token);
    if (userError || !userResult.user?.id) {
      return NextResponse.json({ confirmed: false }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as {
      sessionId?: unknown;
    } | null;
    const sessionId =
      typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
    if (!sessionId || sessionId.length > 500) {
      return NextResponse.json({ confirmed: false }, { status: 400 });
    }

    const session = await stripeClient().checkout.sessions.retrieve(sessionId);
    if (
      session.mode !== "payment" ||
      session.payment_status !== "paid" ||
      session.metadata?.checkout_kind !== "single_credit" ||
      session.metadata?.user_id !== userResult.user.id
    ) {
      return NextResponse.json({ confirmed: false }, { status: 403 });
    }

    const lineItems = await stripeClient().checkout.sessions.listLineItems(
      session.id,
      { limit: 10 }
    );
    const item = lineItems.data[0];
    const definition = resolveSinglePurchaseByPriceId(item?.price?.id);
    if (
      lineItems.data.length !== 1 ||
      item?.quantity !== 1 ||
      !definition ||
      session.metadata?.single_purchase !== definition.key
    ) {
      return NextResponse.json({ confirmed: false }, { status: 400 });
    }

    const sourceKey = `stripe_checkout:${session.id}`;
    const { data: ledger, error: ledgerError } = await db
      .from("single_credit_ledger")
      .select("balance_after")
      .eq("user_id", userResult.user.id)
      .eq("source_key", sourceKey)
      .maybeSingle();
    if (ledgerError) throw ledgerError;

    if (!ledger) {
      return NextResponse.json({ confirmed: false, pending: true });
    }

    const { data: balanceRow, error: balanceError } = await db
      .from("single_credit_balances")
      .select("balance")
      .eq("user_id", userResult.user.id)
      .maybeSingle();
    if (balanceError) throw balanceError;

    return NextResponse.json({
      confirmed: true,
      balance: Number(balanceRow?.balance ?? ledger.balance_after ?? 0),
      creditsAdded: definition.credits,
      amount: definition.amount,
      currency: "JPY",
      conversionId: subscriptionConversionId(session.id),
    });
  } catch (error: unknown) {
    console.error(
      "[single-credit:purchase-status-failed]",
      stripeRouteErrorDiagnostic(error)
    );
    return NextResponse.json({ confirmed: false }, { status: 500 });
  }
}

