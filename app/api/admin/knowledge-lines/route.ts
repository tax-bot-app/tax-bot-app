// app/api/admin/knowledge-lines/route.ts
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
  if (!token) {
    throw Object.assign(new Error("Missing Authorization Bearer token"), { status: 401 });
  }

  const { data: userRes, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userRes?.user) {
    throw Object.assign(new Error("Invalid session"), { status: 401 });
  }

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

  if (!adminRow?.is_admin) {
    throw Object.assign(new Error(`Forbidden (admin only): ${email}`), { status: 403 });
  }

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

export async function GET(req: Request) {
  try {
    const supabase = adminSupabase();
    await requireAdmin(req, supabase);

    const u = new URL(req.url);
    const topic = safeStr(u.searchParams.get("topic")).trim();
    const stance = safeStr(u.searchParams.get("stance")).trim();
    const lens = safeStr(u.searchParams.get("lens")).trim();
    const active = safeStr(u.searchParams.get("active")).trim(); // "true"/"false"/""
    const role = safeStr(u.searchParams.get("role")).trim(); // "user"/"internal"/""

    let q = supabase
      .from("knowledge_lines")
      .select("id, topic, stance, lens, role, text, priority, is_active, created_at")
      .order("topic", { ascending: true })
      .order("lens", { ascending: true })
      .order("stance", { ascending: true })
      .order("role", { ascending: true })
      .order("priority", { ascending: false });

    if (topic) q = q.eq("topic", topic);
    if (stance) q = q.eq("stance", stance);
    if (lens) q = q.eq("lens", lens);
    if (active === "true") q = q.eq("is_active", true);
    if (active === "false") q = q.eq("is_active", false);
    if (role) q = q.eq("role", role);

    const { data, error } = await q;
    if (error) throw error;

    return NextResponse.json({ ok: true, rows: data ?? [] }, { status: 200 });
  } catch (e: any) {
    const status = e?.status ?? 500;
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status });
  }
}

export async function POST(req: Request) {
  try {
    const supabase = adminSupabase();
    await requireAdmin(req, supabase);

    const body = await req.json().catch(() => null);

    const topic = safeStr(body?.topic).trim();
    const stance = safeStr(body?.stance).trim();
    const lens = safeStr(body?.lens).trim();
    const roleRaw = safeStr(body?.role).trim();
    const role: Role = isRole(roleRaw) ? roleRaw : "user";
    const text = safeStr(body?.text).trim();
    const priority = safeInt(body?.priority, 100);
    const is_active = safeBool(body?.is_active, true);

    if (!topic) return NextResponse.json({ ok: false, error: "topic is required" }, { status: 400 });
    if (!text) return NextResponse.json({ ok: false, error: "text is required" }, { status: 400 });
    if (!isStance(stance)) return NextResponse.json({ ok: false, error: "invalid stance" }, { status: 400 });
    if (!isLens(lens)) return NextResponse.json({ ok: false, error: "invalid lens" }, { status: 400 });

    const { data, error } = await supabase
      .from("knowledge_lines")
      .insert({ topic, stance, lens, role, text, priority, is_active })
      .select("id, topic, stance, lens, role, text, priority, is_active, created_at")
      .single();

    if (error) throw error;

    return NextResponse.json({ ok: true, row: data }, { status: 200 });
  } catch (e: any) {
    const status = e?.status ?? 500;
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status });
  }
}
