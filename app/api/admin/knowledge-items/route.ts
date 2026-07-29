// app/api/admin/knowledge-items/route.ts
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

type Kind = "qa";
function isKind(x: string): x is Kind {
  return x === "qa";
}

export async function GET(req: Request) {
  try {
    const supabase = createAdminSupabase();
    await requireAdmin(req, supabase);

    const u = new URL(req.url);
    const kindRaw = safeStr(u.searchParams.get("kind")).trim();
    const kind: Kind = isKind(kindRaw) ? kindRaw : "qa";

    const topic = safeStr(u.searchParams.get("topic")).trim();
    const active = safeStr(u.searchParams.get("active")).trim(); // "true"/"false"/""
    const q = safeStr(u.searchParams.get("q")).trim(); // title/content keyword
    const format = safeStr(u.searchParams.get("format")).trim().toLowerCase();

    let query = supabase
      .from("knowledge_items")
      .select("id, kind, topic, title, content, priority, is_active, created_at, updated_at")
      .eq("kind", kind)
      .order("priority", { ascending: false })
      .order("updated_at", { ascending: false });

    if (topic) query = query.eq("topic", topic);
    if (active === "true") query = query.eq("is_active", true);
    if (active === "false") query = query.eq("is_active", false);

    if (q) {
      const s = q.replace(/[%_]/g, "\\$&");
      query = query.or(`title.ilike.%${s}%,content.ilike.%${s}%`);
    }

    const { data, error } = await query;
    if (error) throw error;

    const rows = data ?? [];

    if (format === "csv") {
      const csvRows = rows.map((r: any) => ({
        topic: safeStr(r?.topic),
        priority: r?.priority ?? "",
        active: String(Boolean(r?.is_active)),
        title: safeStr(r?.title),
        content: safeStr(r?.content),
      }));

      const headers = ["topic", "priority", "active", "title", "content"];
      const csvBody = toCsv(csvRows, headers);
const csv = "\uFEFF" + csvBody; // ★BOM付与（Excel文字化け対策）
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="knowledge_items_${kind}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }

    return NextResponse.json({ ok: true, rows }, { status: 200 });
  } catch (error: unknown) {
    const api = adminApiError(error);
    if (api.status >= 500) {
      console.error("[admin-knowledge-items:get-failed]", adminApiErrorDiagnostic(error));
    }
    return NextResponse.json({ ok: false, error: api.message }, { status: api.status });
  }
}

export async function POST(req: Request) {
  try {
    const supabase = createAdminSupabase();
    await requireAdmin(req, supabase);

    const body = await req.json().catch(() => null);

    const kindRaw = safeStr(body?.kind).trim();
    const kind: Kind = isKind(kindRaw) ? kindRaw : "qa";

    const topic = safeStr(body?.topic).trim();
    const title = safeStr(body?.title).trim();
    const content = safeStr(body?.content).trim();
    const priority = safeInt(body?.priority, 50);
    const is_active = safeBool(body?.is_active, true);

    if (!topic) return NextResponse.json({ ok: false, error: "topic is required" }, { status: 400 });
    if (!title) return NextResponse.json({ ok: false, error: "title is required" }, { status: 400 });
    if (!content) return NextResponse.json({ ok: false, error: "content is required" }, { status: 400 });

    const { data, error } = await supabase
      .from("knowledge_items")
      .insert({
        kind,
        topic,
        title,
        content,
        priority,
        is_active,
        amounts: {},
        conditions: {},
      })
      .select("id, kind, topic, title, content, priority, is_active, created_at, updated_at")
      .single();

    if (error) throw error;

    return NextResponse.json({ ok: true, row: data }, { status: 200 });
  } catch (error: unknown) {
    const api = adminApiError(error);
    if (api.status >= 500) {
      console.error("[admin-knowledge-items:post-failed]", adminApiErrorDiagnostic(error));
    }
    return NextResponse.json({ ok: false, error: api.message }, { status: api.status });
  }
}
