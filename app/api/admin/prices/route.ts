import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json(
    { ok: false, message: "admin/prices not implemented" },
    { status: 404 }
  );
}
