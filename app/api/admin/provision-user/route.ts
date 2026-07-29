import { NextResponse } from "next/server";
import {
  adminApiError,
  adminApiErrorDiagnostic,
  createAdminSupabase,
  requireAdmin,
} from "../../../lib/adminAccess";
import { getPlan } from "../../../lib1/planMaster";

export const runtime = "nodejs";

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

export async function POST(req: Request) {
  try {
    const supabase = createAdminSupabase();
    await requireAdmin(req, supabase);

    const body = (await req.json().catch(() => null)) as { user_id?: string; email?: string } | null;
    const user_id = String(body?.user_id ?? "").trim();
    const email = String(body?.email ?? "").trim().toLowerCase();

    if (!user_id) return NextResponse.json({ ok: false, error: "user_id required" }, { status: 400 });
    if (!isUuid(user_id)) return NextResponse.json({ ok: false, error: "user_id must be uuid" }, { status: 400 });

    // 1) 既に public.users があるなら何もしない（idempotent）
    const { data: existing, error: e0 } = await supabase
      .from("users")
      .select("id,email,plan,monthly_quota,is_admin")
      .eq("id", user_id)
      .maybeSingle();
    if (e0) throw e0;

    if (existing?.id) {
      // email が空で、入力emailがあるなら補完だけはする（任意）
      if ((!existing.email || !String(existing.email).trim()) && email) {
        const { error: ePatch } = await supabase.from("users").update({ email }).eq("id", user_id);
        if (ePatch) throw ePatch;
      }
      return NextResponse.json({ ok: true, user_id, created: false });
    }

    // 2) 無ければ作成（初期free。登録無料体験とは別で、有料チャット枠は0回）
    const freePlan = getPlan("free");
    const { error: e2 } = await supabase.from("users").insert({
      id: user_id,
      email: email || null,
      plan: freePlan.key,
      monthly_quota: freePlan.monthlyQuota,
      is_admin: false,
    });
    if (e2) throw e2;

    return NextResponse.json({ ok: true, user_id, created: true });
  } catch (error: unknown) {
    const api = adminApiError(error);
    if (api.status >= 500) {
      console.error("[admin-provision-user:failed]", adminApiErrorDiagnostic(error));
    }
    return NextResponse.json({ ok: false, error: api.message }, { status: api.status });
  }
}
