// app/api/admin/knowledge-lines/[id]/route.ts
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

async function requireAdminEmail(req: Request, supabase: ReturnType<typeof adminSupabase>): Promise<string> {
  const token = bearerToken(req);
  if (!token) {
    throw Object.assign(new Error("Missing Authorization Bearer token"), { status: 401 });
  }

  const { data: userRes, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userRes?.user) {
    throw Object.assign(new Error("Invalid session"), { status: 401 });
  }

  const email = (userRes.user.email ?? "").toLowerCase();
  if (!email) {
    throw Object.assign(new Error("No email on session"), { status: 401 });
  }

  const { data: adminRow, error: adminErr } = await supabase
    .from("users")
    .select("email, is_admin")
    .eq("email", email)
    .maybeSingle();

  if (adminErr) throw adminErr;

  if (!adminRow?.is_admin) {
    throw Object.assign(new Error(`Forbidden (admin only): ${email}`), { status: 403 });
  }

  return email;
}

function safeStr(x: unknown): string {
  return typeof x === "string" ? x : "";
}
function safeIntOrNull(x: unknown): number | null {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
function safeBoolOrNull(x: unknown): boolean | null {
  if (x === null || x === undefined) return null;
  return typeof x === "boolean" ? x : null;
}

type Stance = "attack" | "defense";
type Lens = "amount" | "substance" | "system";

function isStance(x: string): x is Stance {
  return x === "attack" || x === "defense";
}
function isLens(x: string): x is Lens {
  return x === "amount" || x === "substance" || x === "system";
}

export async function PATCH(req: Request, ctx: { params: { id: string } }) {
  try {
    const supabase = adminSupabase();
    await requireAdminEmail(req, supabase);

    const id = ctx.params.id;
    if (!id) return NextResponse.json({ ok: false, error: "id missing" }, { status: 400 });

    const body = await req.json().catch(() => null);

    const patch: any = {};

    const topic = safeStr(body?.topic).trim();
    const stance = safeStr(body?.stance).trim();
    const lens = safeStr(body?.lens).trim();
    const text = safeStr(body?.text).trim();

    const priority = safeIntOrNull(body?.priority);
    const is_active = safeBoolOrNull(body?.is_active);

    if (topic) patch.topic = topic;

    if (stance) {
      if (!isStance(stance)) return NextResponse.json({ ok: false, error: "invalid stance" }, { status: 400 });
      patch.stance = stance;
    }

    if (lens) {
      if (!isLens(lens)) return NextResponse.json({ ok: false, error: "invalid lens" }, { status: 400 });
      patch.lens = lens;
    }

    if (text) patch.text = text;
    if (priority !== null) patch.priority = priority;
    if (is_active !== null) patch.is_active = is_active;

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ ok: false, error: "no fields to update" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("knowledge_lines")
      .update(patch)
      .eq("id", id)
      .select("id, topic, stance, lens, text, priority, is_active, created_at")
      .single();

    if (error) throw error;

    return NextResponse.json({ ok: true, row: data }, { status: 200 });
  } catch (e: any) {
    const status = e?.status ?? 500;
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status });
  }
}

export async function DELETE(req: Request, ctx: { params: { id: string } }) {
  try {
    const supabase = adminSupabase();
    await requireAdminEmail(req, supabase);

    const id = ctx.params.id;
    if (!id) return NextResponse.json({ ok: false, error: "id missing" }, { status: 400 });

    const { error } = await supabase.from("knowledge_lines").delete().eq("id", id);
    if (error) throw error;

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (e: any) {
    const status = e?.status ?? 500;
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status });
  }
}
