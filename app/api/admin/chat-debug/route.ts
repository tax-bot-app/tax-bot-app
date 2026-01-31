// app/api/admin/chat-debug/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function safeStr(x: unknown): string {
  return typeof x === "string" ? x : "";
}

function parseBool(x: string | null): boolean | null {
  if (x === null || x === "") return null;
  if (x === "true") return true;
  if (x === "false") return false;
  return null;
}

function clampInt(x: string | null, def: number, min: number, max: number): number {
  const n = Number(x);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

// ===== CSV helpers =====
function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  // Excel対策としては本当はBOMもありだが、まずはUTF-8で。必要なら後でBOM版に切替。
  const needs = /[",\r\n]/.test(s);
  const escaped = s.replace(/"/g, '""');
  return needs ? `"${escaped}"` : escaped;
}

function toCsv(rows: Record<string, unknown>[], headers: string[]): string {
  const head = headers.map(csvEscape).join(",");
  const body = rows
    .map((r) => headers.map((h) => csvEscape((r as any)[h])).join(","))
    .join("\n");
  return `${head}\n${body}\n`;
}

function pickedQaTitles(meta: any): string {
  const arr = Array.isArray(meta?.picked_qa) ? meta.picked_qa : [];
  return arr
    .map((q: any) => safeStr(q?.title).trim())
    .filter(Boolean)
    .join(" | ");
}

function pickedLinesSimple(meta: any): string {
  const arr = Array.isArray(meta?.picked_lines) ? meta.picked_lines : [];
  return arr
    .map((l: any) => {
      const stance = safeStr(l?.stance);
      const lens = safeStr(l?.lens);
      const pr = l?.priority ?? "";
      const topic = safeStr(l?.topic);
      const core = [stance, lens, pr].filter(Boolean).join("/");
      return topic ? `${core}:${topic}` : core;
    })
    .filter(Boolean)
    .join(" | ");
}

type ApiRes = { ok: true; rows: any[] } | { ok: false; error: string };

export async function GET(req: Request) {
  try {
    const token = bearer(req);
    if (!token) return NextResponse.json({ ok: false, error: "Missing bearer token" } satisfies ApiRes, { status: 401 });

    // 注意：ここは anon + Bearer ヘッダで RLS 前提の設計のまま維持
    const url = mustEnv("NEXT_PUBLIC_SUPABASE_URL");
    const anon = mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

    const authClient = createClient(url, anon, { auth: { persistSession: false } });
    const { data: userRes, error: userErr } = await authClient.auth.getUser(token);
    if (userErr || !userRes?.user) {
      return NextResponse.json({ ok: false, error: "Invalid session" } satisfies ApiRes, { status: 401 });
    }

    const db = createClient(url, anon, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const u = new URL(req.url);
    const limit = clampInt(u.searchParams.get("limit"), 50, 1, 200);
    const topic = safeStr(u.searchParams.get("topic")).trim();
    const lens = safeStr(u.searchParams.get("lens")).trim();
    const path = safeStr(u.searchParams.get("path")).trim();
    const usedKnowledge = parseBool(u.searchParams.get("used_knowledge"));
    const usedLinesPick = parseBool(u.searchParams.get("used_lines_pick"));
    const q = safeStr(u.searchParams.get("q")).trim();
    const format = safeStr(u.searchParams.get("format")).trim().toLowerCase();

    let query = db
      .from("chat_debug_events")
      .select(
        "id, created_at, user_id, conversation_id, message_head, topics_now, inferred_topic, lens, followup, shifted, path, used_knowledge, used_lines_pick, followup_phase, followup_explicit, line_request, force_normal_answer, meta"
      )
      .order("created_at", { ascending: false })
      .limit(limit);

    if (topic) query = query.eq("inferred_topic", topic);
    if (lens) query = query.eq("lens", lens);
    if (path) query = query.eq("path", path);
    if (usedKnowledge !== null) query = query.eq("used_knowledge", usedKnowledge);
    if (usedLinesPick !== null) query = query.eq("used_lines_pick", usedLinesPick);
    if (q) query = query.ilike("message_head", `%${q}%`);

    const { data, error } = await query;
    if (error) return NextResponse.json({ ok: false, error: error.message } satisfies ApiRes, { status: 400 });

    const rows = data ?? [];

    if (format === "csv") {
      // 合意カラム（存在しないものは meta から拾う or 空）
      const csvRows = rows.map((r: any) => {
        const meta = r?.meta ?? {};
        return {
          created_at: safeStr(r?.created_at),
          message_head: safeStr(r?.message_head),
          topics_now: Array.isArray(r?.topics_now) ? r.topics_now.join(" | ") : safeStr(r?.topics_now),
          inferred_topic: safeStr(r?.inferred_topic),
          subject_topic: safeStr(meta?.subject_topic ?? ""),
          axis_topic: safeStr(meta?.axis_topic ?? ""),
          lens: safeStr(r?.lens),
          qa_pick_reason: safeStr(meta?.qa_pick_reason ?? meta?.pick_reason ?? ""),
          picked_lines: pickedLinesSimple(meta),
          picked_qa: pickedQaTitles(meta),
        };
      });

      const headers = [
        "created_at",
        "message_head",
        "topics_now",
        "inferred_topic",
        "subject_topic",
        "axis_topic",
        "lens",
        "qa_pick_reason",
        "picked_lines",
        "picked_qa",
      ];

      const csv = toCsv(csvRows, headers);
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="chat_debug_events.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }

    return NextResponse.json({ ok: true, rows } satisfies ApiRes, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "Unknown error" } satisfies ApiRes, { status: 500 });
  }
}
