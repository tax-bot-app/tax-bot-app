// app/api/admin/usage/route.ts
import { NextResponse } from "next/server";
import {
  createAdminSupabase,
  requireAdmin,
} from "../../../lib/adminAccess";

export const runtime = "nodejs";

function isMonthKey(s: string): boolean {
  return /^\d{4}-\d{2}$/.test(s);
}

// users基準：未利用ユーザーも used=0 で返す
export async function GET(req: Request) {
  try {
    const supabase = createAdminSupabase();
    await requireAdmin(req, supabase);

    const { searchParams } = new URL(req.url);
    const monthRaw = searchParams.get("month") ?? new Date().toISOString().slice(0, 7);
    const month = isMonthKey(monthRaw) ? monthRaw : new Date().toISOString().slice(0, 7);

    // 1) users 全員（最低限の列）
    const { data: users, error: e1 } = await supabase
      .from("users")
      .select("id,email,plan,monthly_quota,is_admin,created_at")
      .order("created_at", { ascending: false });

    if (e1) throw e1;

    // 2) 当月 usage（ある人だけ）
    const { data: usageRows, error: e2 } = await supabase
      .from("usage")
      .select("user_id,month,used_talks,limit_talks,updated_at")
      .eq("month", month);

    if (e2) throw e2;

    const usageMap = new Map<string, any>();
    for (const r of usageRows ?? []) usageMap.set(String(r.user_id), r);

    // 3) 合成：usageが無ければ0扱いで返す
    const out = (users ?? []).map((u: any) => {
      const uid = String(u.id);
      const ur = usageMap.get(uid);

      const used = ur?.used_talks ?? 0;
      const quota = u.monthly_quota ?? 0;

      // limit_talks は usage側が優先。なければ users.monthly_quota を採用。
      // （無制限は別テーブルで扱うので、ここでは null を作らない）
      const limit = ur?.limit_talks ?? quota;

      return {
        user_id: uid,
        month,
        used_talks: used,
        limit_talks: limit,
        updated_at: ur?.updated_at ?? null,
        users: {
          email: u.email ?? null,
          plan: u.plan ?? "free",
          monthly_quota: quota,
          is_admin: u.is_admin ?? false,
          created_at: u.created_at ?? null,
        },
      };
    });

    // 4) 表示順：usage更新がある人を上、その次は作成日が新しい順
    out.sort((a: any, b: any) => {
      const ta = a.updated_at ? new Date(a.updated_at).getTime() : 0;
      const tb = b.updated_at ? new Date(b.updated_at).getTime() : 0;
      if (tb !== ta) return tb - ta;

      const ca = a.users?.created_at ? new Date(a.users.created_at).getTime() : 0;
      const cb = b.users?.created_at ? new Date(b.users.created_at).getTime() : 0;
      return cb - ca;
    });

    return NextResponse.json({ ok: true, data: out });
  } catch (e: any) {
    const status = e?.status ?? 500;
    if (status >= 500) console.error("admin usage api error", e);

    return NextResponse.json(
      { ok: false, error: e?.message ?? String(e) },
      { status }
    );
  }
}
