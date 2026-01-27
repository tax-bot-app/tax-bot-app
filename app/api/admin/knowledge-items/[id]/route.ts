// app/api/admin/knowledge-items/[id]/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function adminSupabase() {
  const url = mustEnv("SUPABASE_URL");
  const serviceRole = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, serviceRole, { auth: { persistSession: false } });
}

function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

async function requireAdmin(
  req: Request,
  supabase: ReturnType<typeof adminSupabase>
): Promise<{ uid: string; email: string }> {
  const token = bearerToken(req);
  if (!token) throw Object.assign(new Error("Missing Authorization Bearer token"), { status: 401 });

  const { data: userRes, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userRes?.user) throw Object.assign(new Error("Invalid session"), { status: 401 });

  const uid = userRes.user.id;
  const email = (userRes.user.email ?? "").toLowerCase();

  if (!uid) throw Object.assign(new Error("No user id on session"), { status: 401 });
  if (!email) throw Object.assign(new Error("No email on session"), { status: 401 });

  const { data: adminRow, error: adminErr } = await supabase
    .from("users")
    .select("id, is_admin")
    .eq("id", uid)
    .maybeSingle();

  if (adminErr) throw adminErr;
  if (!adminRow?.is_admin) throw Object.assign(new Error(`Forbidden (admin only): ${email}`), { status: 403 });

  return { uid, email };
}

function safeStr(x: unknown): string {
  return typeof x === "string" ? x : "";
}
function safeInt(x: unknown, def: number): number {
  const n = Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}
function safeBool(x: unknown, def: boolean): boolean {
  return typeof x === "boolean" ? x : def;
}

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const supabase = adminSupabase();
    await requireAdmin(req, supabase);

    const { id } = await ctx.params;
    if (!id) return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });

    const body = await req.json().catch(() => null);

    const patch: any = {};
    if (body?.topic !== undefined) patch.topic = safeStr(body?.topic).trim();
    if (body?.title !== undefined) patch.title = safeStr(body?.title).trim();
    if (body?.content !== undefined) patch.content = safeStr(body?.content).trim();
    if (body?.priority !== undefined) patch.priority = safeInt(body?.priority, 50);
    if (body?.is_active !== undefined) patch.is_active = safeBool(body?.is_active, true);

    if (patch.topic !== undefined && !patch.topic)
      return NextResponse.json({ ok: false, error: "topic is required" }, { status: 400 });
    if (patch.title !== undefined && !patch.title)
      return NextResponse.json({ ok: false, error: "title is required" }, { status: 400 });
    if (patch.content !== undefined && !patch.content)
      return NextResponse.json({ ok: false, error: "content is required" }, { status: 400 });

    const { data, error } = await supabase
      .from("knowledge_items")
      .update(patch)
      .eq("id", id)
      .select("id, kind, topic, title, content, priority, is_active, created_at, updated_at")
      .single();

    if (error) throw error;

    return NextResponse.json({ ok: true, row: data }, { status: 200 });
  } catch (e: any) {
    const status = e?.status ?? 500;
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status });
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const supabase = adminSupabase();
    await requireAdmin(req, supabase);

    const { id } = await ctx.params;
    if (!id) return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });

    const { error } = await supabase.from("knowledge_items").delete().eq("id", id);
    if (error) throw error;

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (e: any) {
    const status = e?.status ?? 500;
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status });
  }
}
