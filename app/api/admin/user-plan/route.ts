// app/api/admin/user-plan/route.ts
import { NextResponse } from "next/server";
import {
  adminApiError,
  adminApiErrorDiagnostic,
  createAdminSupabase,
  requireAdmin,
} from "../../../lib/adminAccess";
import { getPlan, isPlanKey } from "../../../lib1/planMaster";

export const runtime = "nodejs";

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

export async function POST(req: Request) {
  try {
    const supabase = createAdminSupabase();
    await requireAdmin(req, supabase);

    const body = (await req.json().catch(() => null)) as { user_id?: string; plan?: string } | null;
    const user_id = String(body?.user_id ?? "").trim();
    const planRaw = String(body?.plan ?? "").trim().toLowerCase();

    if (!user_id) return NextResponse.json({ ok: false, error: "user_id required" }, { status: 400 });
    if (!isUuid(user_id)) return NextResponse.json({ ok: false, error: "user_id must be uuid" }, { status: 400 });
    if (!isPlanKey(planRaw)) {
      return NextResponse.json({ ok: false, error: `invalid plan: ${planRaw}` }, { status: 400 });
    }

    const monthly_quota = getPlan(planRaw).monthlyQuota;

    const { error } = await supabase
      .from("users")
      .update({ plan: planRaw, monthly_quota })
      .eq("id", user_id);

    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    const api = adminApiError(error);
    if (api.status >= 500) {
      console.error("[admin-user-plan:failed]", adminApiErrorDiagnostic(error));
    }
    return NextResponse.json({ ok: false, error: api.message }, { status: api.status });
  }
}
