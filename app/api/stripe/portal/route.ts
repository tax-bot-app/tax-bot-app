// app/api/stripe/portal/route.ts
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { siteOrigin } from "../../../lib/siteOrigin";

export const runtime = "nodejs";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function bearerFromReq(req: Request): string | null {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
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

export async function POST(req: Request) {
  try {
    const token = bearerFromReq(req);
    if (!token) return NextResponse.json({ ok: false, error: "Missing Authorization: Bearer" }, { status: 401 });

    // 1) tokenからuser特定
    const url = mustEnv("SUPABASE_URL");
    const anon = mustEnv("SUPABASE_ANON_KEY");
    const supabaseAuth = createClient(url, anon, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false },
    });

    const { data: u, error: uErr } = await supabaseAuth.auth.getUser();
    if (uErr || !u?.user) return NextResponse.json({ ok: false, error: "Invalid token" }, { status: 401 });

    const email = u.user.email;
    if (!email) return NextResponse.json({ ok: false, error: "No email on auth user" }, { status: 400 });

    const supabase = adminSupabase();

    // 2) usersから stripe_customer_id を取得
    const { data: row, error: rowErr } = await supabase
      .from("users")
      .select("id,email,stripe_customer_id")
      .eq("email", email)
      .maybeSingle();

    if (rowErr) throw rowErr;

    let customerId = row?.stripe_customer_id ?? null;

    // 3) 無ければStripe Customer作成して保存
    if (!customerId) {
      const customer = await stripeClient().customers.create({ email });
      customerId = customer.id;

      const { error: updErr } = await supabase
        .from("users")
        .update({ stripe_customer_id: customerId, updated_at: new Date().toISOString() })
        .eq("email", email);

      if (updErr) throw updErr;
    }

    // 4) Portal Session作成
    const appUrl = siteOrigin();
    const session = await stripeClient().billingPortal.sessions.create({
      customer: customerId,
      return_url: `${appUrl}/chat`,
    });

    return NextResponse.json({ ok: true, url: session.url }, { status: 200 });
  } catch (e: unknown) {
    console.error("portal route error", e);
    return NextResponse.json({ ok: false, error: errorMessage(e) }, { status: 500 });
  }
}
