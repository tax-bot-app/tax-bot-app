// app/api/stripe/portal/route.ts
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function bearerFromReq(req: Request): string | null {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

const stripe = new Stripe(mustEnv("STRIPE_SECRET_KEY"), {
  apiVersion: "2025-12-15.clover",
});

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
      const customer = await stripe.customers.create({ email });
      customerId = customer.id;

      const { error: updErr } = await supabase
        .from("users")
        .update({ stripe_customer_id: customerId, updated_at: new Date().toISOString() })
        .eq("email", email);

      if (updErr) throw updErr;
    }

    // 4) Portal Session作成
    const appUrl = mustEnv("APP_URL"); // 本番URL固定推奨
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${appUrl}/chat`,
    });

    return NextResponse.json({ ok: true, url: session.url }, { status: 200 });
  } catch (e: any) {
    console.error("portal route error", e);
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}
