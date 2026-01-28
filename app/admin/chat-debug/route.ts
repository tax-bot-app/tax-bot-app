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

type ApiRes = { ok: true; rows: any[] } | { ok: false; error: string };

export async function GET(req: Request) {
  try {
    const token = bearer(req);
    if (!token) return NextResponse.json({ ok: false, error: "Missing bearer token" } satisfies ApiRes, { status: 401 });

    const url = mustEnv("NEXT_PUBLIC_SUPABASE_URL");
    const anon = mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

    const authClient = createClient(url, anon, { auth: { persistSession: false } });
    const { data: userRes, error: userErr } = await authClient.auth.getUser(token);
    if (userErr || !userRes?.user) return NextResponse.json({ ok: false, error: "Invalid session" } satisfies ApiRes, { status: 401 });

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

    return NextResponse.json({ ok: true, rows: data ?? [] } satisfies ApiRes, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "Unknown error" } satisfies ApiRes, { status: 500 });
  }
}
