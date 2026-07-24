import { NextResponse } from "next/server";
import {
  createAdminSupabase,
  requireAdmin,
} from "../../../lib/adminAccess";

export const runtime = "nodejs";

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

export async function GET(req: Request) {
  try {
    const supabase = createAdminSupabase();
    await requireAdmin(req, supabase);

    const { data, error } = await supabase
      .from("unlimited_allowlist")
      .select(`user_id, label, created_at, users:users(email)`)
      .order("created_at", { ascending: false });

    if (error) throw error;

    const rows = (data ?? []).map((r: any) => ({
      user_id: String(r.user_id),
      label: r.label ?? null,
      created_at: String(r.created_at),
      email: r.users?.email ?? null,
    }));

    return NextResponse.json({ ok: true, data: rows });
  } catch (e: any) {
    const status = e?.status ?? 500;
    if (status >= 500) console.error("admin allowlist api error", e);
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status });
  }
}

export async function POST(req: Request) {
  try {
    const supabase = createAdminSupabase();
    await requireAdmin(req, supabase);

    const body = (await req.json().catch(() => null)) as { user_id?: string; label?: string } | null;
    const user_id = (body?.user_id ?? "").trim();
    const label = (body?.label ?? "").trim();

    if (!user_id) return NextResponse.json({ ok: false, error: "user_id required" }, { status: 400 });
    if (!isUuid(user_id)) return NextResponse.json({ ok: false, error: "user_id must be uuid" }, { status: 400 });

    const { error } = await supabase.from("unlimited_allowlist").upsert({ user_id, label });
    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const status = e?.status ?? 500;
    if (status >= 500) console.error("admin allowlist api error", e);
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status });
  }
}

export async function DELETE(req: Request) {
  try {
    const supabase = createAdminSupabase();
    await requireAdmin(req, supabase);

    const body = (await req.json().catch(() => null)) as { user_id?: string } | null;
    const user_id = (body?.user_id ?? "").trim();

    if (!user_id) return NextResponse.json({ ok: false, error: "user_id required" }, { status: 400 });
    if (!isUuid(user_id)) return NextResponse.json({ ok: false, error: "user_id must be uuid" }, { status: 400 });

    const { error } = await supabase.from("unlimited_allowlist").delete().eq("user_id", user_id);
    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const status = e?.status ?? 500;
    if (status >= 500) console.error("admin allowlist api error", e);
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status });
  }
}
