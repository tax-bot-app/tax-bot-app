// app/api/chat/status/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getPlan, normalizePlanKey, type PlanKey } from "../../../lib1/planMaster";

type StatusRes =
  | { ok: true; plan: PlanKey; used_talks: number; limit_talks: number }
  | { ok: false; error: string };

function env(name: string): string | undefined {
  return process.env[name];
}
function getSupabaseUrl(): string {
  return env("SUPABASE_URL") || env("NEXT_PUBLIC_SUPABASE_URL") || "";
}
function getSupabaseAnonKey(): string {
  return env("SUPABASE_ANON_KEY") || env("NEXT_PUBLIC_SUPABASE_ANON_KEY") || "";
}
function bearerFromReq(req: Request): string | null {
  const auth = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

export async function GET(req: Request) {
  try {
    const supabaseUrl = getSupabaseUrl();
    const supabaseAnonKey = getSupabaseAnonKey();
    if (!supabaseUrl || !supabaseAnonKey) {
      return NextResponse.json({ ok: false, error: "server env missing (supabase)" } satisfies StatusRes, { status: 500 });
    }

    const accessToken = bearerFromReq(req);
    if (!accessToken) {
      return NextResponse.json({ ok: false, error: "missing bearer token" } satisfies StatusRes, { status: 401 });
    }

    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey);
    const { data: userData, error: userErr } = await supabaseAuth.auth.getUser(accessToken);
    if (userErr || !userData?.user) {
      return NextResponse.json({ ok: false, error: "unauthorized" } satisfies StatusRes, { status: 401 });
    }
    const user = userData.user;

    const supabaseDb = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    // plan
    const { data: urow, error: uerr } = await supabaseDb
      .from("users")
      .select("plan")
      .eq("id", user.id)
      .maybeSingle();

    if (uerr) {
      console.error("users select error:", uerr);
      return NextResponse.json({ ok: false, error: "db error (users)" } satisfies StatusRes, { status: 500 });
    }

    const plan: PlanKey = normalizePlanKey(urow?.plan ?? "free");
    const limit_talks = getPlan(plan).monthlyQuota;

    // ✅ JST month_key をDBに聞く（これがブレない）
    const { data: mk, error: mkErr } = await supabaseDb.rpc("month_key_jst");
    if (mkErr) {
      console.error("month_key_jst error:", mkErr);
      return NextResponse.json({ ok: false, error: "db error (month_key_jst)" } satisfies StatusRes, { status: 500 });
    }
    const month = String(Array.isArray(mk) ? mk[0] : mk);

    // usage
    const { data: usageRow, error: usErr } = await supabaseDb
      .from("usage")
      .select("used_talks")
      .eq("user_id", user.id)
      .eq("month", month)
      .maybeSingle();

    if (usErr) console.warn("usage select warn:", usErr);

    const used_talks = usageRow?.used_talks ?? 0;

    return NextResponse.json({ ok: true, plan, used_talks, limit_talks } satisfies StatusRes, { status: 200 });
  } catch (e: any) {
    console.error("status route fatal:", e);
    return NextResponse.json({ ok: false, error: `server error: ${e?.message ?? "unknown"}` } satisfies StatusRes, { status: 500 });
  }
}
