// app/api/admin/knowledge-items/[id]/route.ts
import { NextResponse } from "next/server";
import {
  createAdminSupabase,
  requireAdmin,
} from "../../../../lib/adminAccess";

export const runtime = "nodejs";

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
    const supabase = createAdminSupabase();
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
    const supabase = createAdminSupabase();
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
