import { NextRequest } from "next/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-12-15.clover",
});

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  const sig = req.headers.get("stripe-signature");
  if (!sig) {
    return new Response("No signature", { status: 400 });
  }

  const body = await req.text();

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err: any) {
    console.error("Webhook signature verification failed:", err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      const customerEmail = session.customer_details?.email;
      const customerId = session.customer as string;

      if (!customerEmail) {
        console.warn("No customer email in session");
        return new Response("ok", { status: 200 });
      }

      const plan = "lite";
      const monthly_quota = 5;

      const { error } = await supabase
        .from("users")
        .update({
          plan,
          monthly_quota,
          stripe_customer_id: customerId,
          updated_at: new Date().toISOString(),
        })
        .eq("email", customerEmail);

      if (error) {
        console.error("Supabase update error:", error);
        return new Response("DB update failed", { status: 500 });
      }

      console.log("User upgraded:", customerEmail);
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("Webhook handler error:", err);
    return new Response("Webhook handler failed", { status: 500 });
  }
}
