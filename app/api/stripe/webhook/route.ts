import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ブラウザで開いて確認できるように GET も返す（デバッグ）
export async function GET() {
  return NextResponse.json({ ok: true, route: "/api/stripe/webhook", method: "GET" });
}

export async function POST(req: Request) {
  // まずは「POSTがここに届いてる」ことだけ確認
  const sig = req.headers.get("stripe-signature");
  const body = await req.text();

  return NextResponse.json({
    ok: true,
    route: "/api/stripe/webhook",
    method: "POST",
    hasStripeSignature: !!sig,
    bodyLength: body.length,
  });
}
