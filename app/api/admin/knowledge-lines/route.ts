// app/api/admin/knowledge-lines/route.ts
import { NextResponse } from "next/server";
import {
  adminApiError,
  adminApiErrorDiagnostic,
  createAdminSupabase,
  requireAdmin,
} from "../../../lib/adminAccess";

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

// ===== CSV helpers =====
function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  const needs = /[",\r\n]/.test(s);
  const escaped = s.replace(/"/g, '""');
  return needs ? `"${escaped}"` : escaped;
}
function toCsv(rows: Record<string, unknown>[], headers: string[]): string {
  const head = headers.map(csvEscape).join(",");
  const body = rows.map((r) => headers.map((h) => csvEscape((r as any)[h])).join(",")).join("\n");
  return `${head}\n${body}\n`;
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
    const supabase = createAdminSupabase();
    await requireAdmin(req, supabase);

    const u = new URL(req.url);
    const topic = safeStr(u.searchParams.get("topic")).trim();
    const stance = safeStr(u.searchParams.get("stance")).trim();
    const lens = safeStr(u.searchParams.get("lens")).trim();
    const active = safeStr(u.searchParams.get("active")).trim(); // "true"/"false"/""
    const role = safeStr(u.searchParams.get("role")).trim(); // "user"/"internal"/""
    const format = safeStr(u.searchParams.get("format")).trim().toLowerCase();

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

    const rows = data ?? [];

    if (format === "csv") {
      const csvRows = rows.map((r: any) => ({
        topic: safeStr(r?.topic),
        priority: r?.priority ?? "",
        active: String(Boolean(r?.is_active)),
        lens: safeStr(r?.lens),
        stance: safeStr(r?.stance),
        role: safeStr(r?.role),
        text: safeStr(r?.text),
      }));

      const headers = ["topic", "priority", "active", "lens", "stance", "role", "text"];
      const csvBody = toCsv(csvRows, headers);
const csv = "\uFEFF" + csvBody; // ★BOM付与（Excel文字化け対策）

      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="knowledge_lines.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }

    return NextResponse.json({ ok: true, rows }, { status: 200 });
  } catch (error: unknown) {
    const api = adminApiError(error);
    if (api.status >= 500) {
      console.error("[admin-knowledge-lines:get-failed]", adminApiErrorDiagnostic(error));
    }
    return NextResponse.json({ ok: false, error: api.message }, { status: api.status });
  }
}

export async function POST(req: Request) {
  try {
    const supabase = createAdminSupabase();
    await requireAdmin(req, supabase);

    const body = await req.json().catch(() => null);

    const topic = safeStr(body?.topic).trim();
    const stanceRaw = safeStr(body?.stance).trim();
    const lensRaw = safeStr(body?.lens).trim();
    const roleRaw = safeStr(body?.role).trim();
    const role: Role = isRole(roleRaw) ? roleRaw : "user";

    const text = safeStr(body?.text).trim();
    const priority = safeInt(body?.priority, 100);
    const is_active = safeBool(body?.is_active, true);

    if (!topic) return NextResponse.json({ ok: false, error: "topic is required" }, { status: 400 });
    if (!text) return NextResponse.json({ ok: false, error: "text is required" }, { status: 400 });
    if (!isStance(stanceRaw)) return NextResponse.json({ ok: false, error: "invalid stance" }, { status: 400 });
    if (!isLens(lensRaw)) return NextResponse.json({ ok: false, error: "invalid lens" }, { status: 400 });

    const { data, error } = await supabase
      .from("knowledge_lines")
      .insert({ topic, stance: stanceRaw, lens: lensRaw, role, text, priority, is_active })
      .select("id, topic, stance, lens, role, text, priority, is_active, created_at")
      .single();

    if (error) throw error;

    return NextResponse.json({ ok: true, row: data }, { status: 200 });
  } catch (error: unknown) {
    const api = adminApiError(error);
    if (api.status >= 500) {
      console.error("[admin-knowledge-lines:post-failed]", adminApiErrorDiagnostic(error));
    }
    return NextResponse.json({ ok: false, error: api.message }, { status: api.status });
  }
}
