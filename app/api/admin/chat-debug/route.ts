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

function jsonish(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v; // 既にJSON文字列として入ってるケースもある
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
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
    .join("\n");
}

type ApiRes = { ok: true; rows: any[] } | { ok: false; error: string };

export async function GET(req: Request) {
  try {
    const token = bearer(req);
    if (!token) {
      return NextResponse.json({ ok: false, error: "Missing bearer token" } satisfies ApiRes, { status: 401 });
    }

    // anon + Bearer（RLS前提）
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

    // NEW: created_at range
    const from = safeStr(u.searchParams.get("from")).trim(); // ISO string 推奨
    const to = safeStr(u.searchParams.get("to")).trim();

    // NEW: conversation_id filter
    const conversationId = safeStr(u.searchParams.get("conversation_id")).trim();

    let query = db
      .from("chat_debug_events")
      .select(
        "id, created_at, user_id, conversation_id, message_head, topics_now, inferred_topic, lens, followup, shifted, path, used_knowledge, used_lines_pick, followup_phase, followup_explicit, line_request, force_normal_answer, meta"
      )
      .order("created_at", { ascending: false })
      .limit(limit);

    if (from) query = query.gte("created_at", from);
    if (to) query = query.lte("created_at", to);

    if (conversationId) query = query.eq("conversation_id", conversationId);
    if (topic) query = query.eq("inferred_topic", topic);
    if (lens) query = query.eq("lens", lens);
    if (path) query = query.eq("path", path);
    if (usedKnowledge !== null) query = query.eq("used_knowledge", usedKnowledge);
    if (usedLinesPick !== null) query = query.eq("used_lines_pick", usedLinesPick);
    if (q) query = query.ilike("message_head", `%${q}%`);

    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ ok: false, error: error.message } satisfies ApiRes, { status: 400 });
    }

    const rows = data ?? [];

    if (format === "csv") {
      const headers = [
        // 基本
        "created_at",
        "conversation_id",
        "message_head",
        "topics_now",
        "inferred_topic",
        "lens",
        "followup",
        "shifted",
        "path",
        "used_knowledge",
        "used_lines_pick",

        // トピック/軸
        "subject_topic",
        "axis_topic",
        "audit_axis",
        "topic_mode",

        // LLM intent
        "llm_intent",
        "llm_confidence",
        "llm_topic_ok",
        "llm_reason",

        // レンズ（肝）
        "prefer_rule_lens",
        "lens_pre",
        "lens_rule",
        "lens_llm",
        "lens_final",
        "lens_for_lines",

        // QA / Lines
        "qa_pick_reason",
        "picked_qa",
        "picked_lines",
        "allow_lines",

        // Lines pick の実行状況
        "lines_pick_attempted",
        "lines_pick_lens_used",
        "lines_pick_success",

        // nudge lines（肝）
        "nudge_lines_llm",
        "nudge_lines_applied",
        "nudge_lines_reason",

        // topic debug
        "topic_raw",
        "topic_raw_json",
        "topic_codepoints_tail",
        "topic_normalized",
        "topic_hits",

        // flow debug
        "prev_debug_path",
        "prev_debug_lens",
        "borrowed_prev_topic",
        "weak_utterance",
        "lines_cooldown_applied",
        "lines_keep_reason",
        "lines_blocked_no_subject",
        "lines_suppressed_short_ack",

        // clarify / implicit shift
        "clarify_prev_answer",
        "clarify_term",
        "clarify_matched",
        "implicit_shift",
        "implicit_shift_unstick",
        "audit_essence_injected",
      ];

      const csvRows = rows.map((r: any) => {
        const meta = r?.meta ?? {};
        return {
          // 基本
          created_at: safeStr(r?.created_at),
          conversation_id: safeStr(r?.conversation_id),
          message_head: safeStr(r?.message_head),
          topics_now: Array.isArray(r?.topics_now) ? r.topics_now.join(" | ") : safeStr(r?.topics_now),
          inferred_topic: safeStr(r?.inferred_topic),
          lens: safeStr(r?.lens),
          followup: String(Boolean(r?.followup)),
          shifted: String(Boolean(r?.shifted)),
          path: safeStr(r?.path),
          used_knowledge: String(Boolean(r?.used_knowledge)),
          used_lines_pick: String(Boolean(r?.used_lines_pick)),

          // トピック/軸
          subject_topic: safeStr(meta?.subject_topic ?? ""),
          axis_topic: safeStr(meta?.axis_topic ?? ""),
          audit_axis: String(Boolean(meta?.audit_axis)),
          topic_mode: safeStr(meta?.topic_mode ?? ""),

          // LLM
          llm_intent: safeStr(meta?.llm_intent ?? ""),
          llm_confidence:
            meta?.llm_confidence === undefined || meta?.llm_confidence === null ? "" : String(meta.llm_confidence),
          llm_topic_ok:
            meta?.llm_topic_ok === undefined || meta?.llm_topic_ok === null ? "" : String(Boolean(meta.llm_topic_ok)),
          llm_reason: safeStr(meta?.llm_reason ?? ""),

          // レンズ（肝）
          prefer_rule_lens: String(Boolean(meta?.prefer_rule_lens)),
          lens_pre: safeStr(meta?.lens_pre ?? ""),
          lens_rule: safeStr(meta?.lens_rule ?? ""),
          lens_llm: safeStr(meta?.lens_llm ?? ""),
          lens_final: safeStr(meta?.lens_final ?? ""),
          lens_for_lines: safeStr(meta?.lens_for_lines ?? ""),

          // QA / Lines
          qa_pick_reason: safeStr(meta?.qa_pick_reason ?? meta?.pick_reason ?? ""),
          picked_qa: pickedQaTitles(meta),
          picked_lines: pickedLinesSimple(meta),
          allow_lines: String(Boolean(meta?.allow_lines)),

          // lines pick
          lines_pick_attempted: String(Boolean(meta?.lines_pick_attempted)),
          lines_pick_lens_used: meta?.lines_pick_lens_used === null || meta?.lines_pick_lens_used === undefined ? "" : String(meta.lines_pick_lens_used),
          lines_pick_success: String(Boolean(meta?.lines_pick_success)),

          // nudge lines
          nudge_lines_llm: String(Boolean(meta?.nudge_lines_llm)),
          nudge_lines_applied: String(Boolean(meta?.nudge_lines_applied)),
          nudge_lines_reason: safeStr(meta?.nudge_lines_reason ?? ""),

          // topic debug
          topic_raw: safeStr(meta?.topic_raw ?? ""),
          topic_raw_json: jsonish(meta?.topic_raw_json ?? ""),
          topic_codepoints_tail: safeStr(meta?.topic_codepoints_tail ?? ""),
          topic_normalized: safeStr(meta?.topic_normalized ?? ""),
          topic_hits: jsonish(meta?.topic_hits ?? ""),

          // flow debug
          prev_debug_path: safeStr(meta?.prev_debug_path ?? ""),
          prev_debug_lens: safeStr(meta?.prev_debug_lens ?? ""),
          borrowed_prev_topic: String(Boolean(meta?.borrowed_prev_topic)),
          weak_utterance: String(Boolean(meta?.weak_utterance)),
          lines_cooldown_applied: String(Boolean(meta?.lines_cooldown_applied)),
          lines_keep_reason: safeStr(meta?.lines_keep_reason ?? ""),
          lines_blocked_no_subject: String(Boolean(meta?.lines_blocked_no_subject)),
          lines_suppressed_short_ack: String(Boolean(meta?.lines_suppressed_short_ack)),

          // clarify / implicit shift
          clarify_prev_answer: String(Boolean(meta?.clarify_prev_answer)),
          clarify_term: safeStr(meta?.clarify_term ?? ""),
          clarify_matched: safeStr(meta?.clarify_matched ?? ""),
          implicit_shift: String(Boolean(meta?.implicit_shift)),
          implicit_shift_unstick: String(Boolean(meta?.implicit_shift_unstick)),
          audit_essence_injected: String(Boolean(meta?.audit_essence_injected)),
        };
      });

      const csvBody = toCsv(csvRows, headers);
      const csv = "\uFEFF" + csvBody; // BOM（Excel対策）

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
