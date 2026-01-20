import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json(
    { ok: false, message: "admin/usage/summary not implemented" },
    { status: 404 }
  );
}
