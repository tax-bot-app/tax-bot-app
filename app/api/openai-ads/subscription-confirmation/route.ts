import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import Stripe from "stripe";

import {
  isConfirmedSubscription,
  subscriptionConversionId,
} from "../../../lib/openaiAdsSubscription";
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

    const { data, error } = await adminSupabase().auth.getUser(token);
    if (error || !data.user?.id) {
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
    if (session.metadata?.user_id !== data.user.id) {
      return NextResponse.json({ confirmed: false }, { status: 403 });
    }

    const subscriptionId =
      typeof session.subscription === "string"
        ? session.subscription
        : session.subscription?.id ?? null;

    if (!subscriptionId) {
      return NextResponse.json({ confirmed: false }, { status: 200 });
    }

    const subscription = await stripeClient().subscriptions.retrieve(
      subscriptionId
    );
    const confirmed = isConfirmedSubscription({
      checkoutMode: session.mode,
      checkoutStatus: session.status,
      subscriptionStatus: subscription.status,
    });

    return NextResponse.json(
      confirmed
        ? {
            confirmed: true,
            conversionId: subscriptionConversionId(session.id),
          }
        : { confirmed: false },
      { status: 200 }
    );
  } catch (error: unknown) {
    console.error(
      "[openai-ads:subscription-confirmation-failed]",
      stripeRouteErrorDiagnostic(error)
    );
    return NextResponse.json({ confirmed: false }, { status: 500 });
  }
}

