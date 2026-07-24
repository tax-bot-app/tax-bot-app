// app/api/admin/knowledge-lines/[id]/route.ts
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

type Role = "user" | "internal";
type Stance = "attack" | "defense";
type Lens = "amount" | "substance" | "system";

function isRole(x: string): x is Role {
  return x === "user" || x === "internal";
}
function isStance(x: string): x is Stance {
  return x === "attack" || x === "defense";
}
function isLens(x: string): x is Lens {
  return x === "amount" || x === "substance" || x === "system";
}

// ★ここがポイント：params は Promise 扱い
type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const supabase = createAdminSupabase();
    await requireAdmin(req, supabase);

    const { id } = await ctx.params;
    if (!id) return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });

    const body = await req.json().catch(() => null);

    const topic = safeStr(body?.topic).trim();
    const stanceRaw = safeStr(body?.stance).trim();
    const lensRaw = safeStr(body?.lens).trim();
    const roleRaw = safeStr(body?.role).trim();
    const text = safeStr(body?.text).trim();
    const priority = safeInt(body?.priority, 100);
    const is_active = safeBool(body?.is_active, true);

    const patch: any = {};
    if (body?.topic !== undefined) patch.topic = topic;
    if (body?.stance !== undefined) {
      if (!isStance(stanceRaw)) return NextResponse.json({ ok: false, error: "invalid stance" }, { status: 400 });
      patch.stance = stanceRaw;
    }
    if (body?.lens !== undefined) {
      if (!isLens(lensRaw)) return NextResponse.json({ ok: false, error: "invalid lens" }, { status: 400 });
      patch.lens = lensRaw;
    }
    if (body?.role !== undefined) patch.role = isRole(roleRaw) ? roleRaw : "user";
    if (body?.text !== undefined) patch.text = text;
    if (body?.priority !== undefined) patch.priority = priority;
    if (body?.is_active !== undefined) patch.is_active = is_active;

    if (patch.topic !== undefined && !patch.topic)
      return NextResponse.json({ ok: false, error: "topic is required" }, { status: 400 });
    if (patch.text !== undefined && !patch.text)
      return NextResponse.json({ ok: false, error: "text is required" }, { status: 400 });

    const { data, error } = await supabase
      .from("knowledge_lines")
      .update(patch)
      .eq("id", id)
      .select("id, topic, stance, lens, role, text, priority, is_active, created_at")
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

    const { error } = await supabase.from("knowledge_lines").delete().eq("id", id);
    if (error) throw error;

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (e: any) {
    const status = e?.status ?? 500;
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status });
  }
}
