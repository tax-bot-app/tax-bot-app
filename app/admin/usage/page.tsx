"use client";

import { useEffect, useMemo, useState } from "react";
import { getSupabaseClient } from "@/app/lib/supabaseClient";

type Row = {
  user_id: string;
  month: string;
  used_talks: number | null;
  limit_talks: number | null;
  updated_at: string | null;
  users: {
    email: string | null;
    plan: string | null;
    monthly_quota: number | null;
    is_admin?: boolean | null;
    created_at?: string | null; // ★APIで返す（route.tsで追加）
  } | null;
};

type AllowRow = {
  user_id: string;
  label: string | null;
  created_at: string;
  email: string | null;
};

type SortKey =
  | "email"
  | "plan"
  | "monthly_quota"
  | "month"
  | "used_talks"
  | "limit_talks"
  | "remaining"
  | "pct"
  | "months_active"
  | "revenue_yen"
  | "updated_at";

function currentMonthKeyJST(): string {
  const d = new Date();
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 7);
}

function toMonthDate(monthKey: string): Date | null {
  // "YYYY-MM" -> Date(YYYY, MM-1, 1)
  const m = String(monthKey ?? "");
  if (!/^\d{4}-\d{2}$/.test(m)) return null;
  const y = Number(m.slice(0, 4));
  const mo = Number(m.slice(5, 7));
  if (!y || !mo) return null;
  return new Date(y, mo - 1, 1);
}

function diffMonthsInclusive(fromISO: string | null | undefined, toMonthKey: string): number | null {
  // 継続月数（ざっくり）：users.created_at -> 指定month の月初 までの月差 + 1
  if (!fromISO) return null;
  const from = new Date(fromISO);
  if (Number.isNaN(from.getTime())) return null;

  const to = toMonthDate(toMonthKey);
  if (!to) return null;

  const fy = from.getFullYear();
  const fm = from.getMonth();
  const ty = to.getFullYear();
  const tm = to.getMonth();

  const diff = (ty - fy) * 12 + (tm - fm);
  return Math.max(diff + 1, 1);
}

// 想定売上（円/月）— 管理画面用。
const PLAN_PRICE_YEN: Record<string, number> = {
  free: 0,
  lite: 1480,
  standard: 4800,
  enterprise: 9800,
};

function priceFor(planRaw: string | null | undefined): number {
  const p = String(planRaw ?? "free").toLowerCase();
  return PLAN_PRICE_YEN[p] ?? 0;
}

function fmtYen(n: number): string {
  try {
    return n.toLocaleString("ja-JP") + "円";
  } catch {
    return `${n}円`;
  }
}

export default function AdminUsagePage() {
  const supabase = useMemo(() => getSupabaseClient(), []);

  const [month, setMonth] = useState(currentMonthKeyJST());
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<number | null>(null);

  // sort
  const [sortKey, setSortKey] = useState<SortKey>("updated_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  
  // ===== plan editor =====
const [planDraft, setPlanDraft] = useState<Record<string, string>>({});
const [planSaving, setPlanSaving] = useState<Record<string, boolean>>({});
  

  // ===== unlimited allowlist =====
  const [allowRows, setAllowRows] = useState<AllowRow[]>([]);
  const [allowUserId, setAllowUserId] = useState("");
  const [allowLabel, setAllowLabel] = useState("");
  const [allowLoading, setAllowLoading] = useState(false);
  // ===== provision user (auth UID -> public.users) =====
  const [provUserId, setProvUserId] = useState("");
  const [provEmail, setProvEmail] = useState("");
  const [provLoading, setProvLoading] = useState(false);
  const [provMsg, setProvMsg] = useState<string | null>(null);

  async function tokenOrThrow(): Promise<string> {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;

    const t = data.session?.access_token;
    if (!t) throw new Error("Not logged in. 先に /login してな。");
    return t;
  }

  async function apiFetch(path: string, init?: RequestInit) {
    const token = await tokenOrThrow();
    return fetch(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    });
  }

  // ===== load usage =====
  useEffect(() => {
    (async () => {
      setLoading(true);
      setErr(null);
      setStatus(null);

      try {
        const res = await apiFetch(`/api/admin/usage?month=${encodeURIComponent(month)}`);
        setStatus(res.status);

        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);

        setRows((json.data ?? []) as Row[]);
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        if (msg.includes("Not logged in")) setStatus(401);

        setErr(msg);
        setRows([]);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  // ===== allowlist =====
  async function loadAllowlist() {
    setAllowLoading(true);
    try {
      const res = await apiFetch("/api/admin/unlimited-allowlist");
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      setAllowRows((json.data ?? []) as AllowRow[]);
    } finally {
      setAllowLoading(false);
    }
  }

  async function upsertAllowlist() {
    const uid = allowUserId.trim();
    if (!uid) throw new Error("user_id が空やで");

    const res = await apiFetch("/api/admin/unlimited-allowlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: uid, label: allowLabel.trim() }),
    });

    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);

    setAllowUserId("");
    setAllowLabel("");
    await loadAllowlist();
  }

  async function deleteAllowlist(uid: string) {
    const res = await apiFetch("/api/admin/unlimited-allowlist", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: uid }),
    });

    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);

    await loadAllowlist();
  }

  async function saveUserPlan(userId: string, plan: string) {
    setPlanSaving((m) => ({ ...m, [userId]: true }));
    try {
      const res = await apiFetch("/api/admin/user-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, plan }),
      });

      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);

      // ✅ 反映のため usage を再取得（plan/quotaが users から出るので）
      const res2 = await apiFetch(`/api/admin/usage?month=${encodeURIComponent(month)}`);
      const json2 = await res2.json().catch(() => null);
      if (!res2.ok || !json2?.ok) throw new Error(json2?.error ?? `HTTP ${res2.status}`);
      setRows((json2.data ?? []) as Row[]);
    } finally {
      setPlanSaving((m) => ({ ...m, [userId]: false }));
    }
  }

async function provisionUser() {
    const uid = provUserId.trim();
    const email = provEmail.trim();
    if (!uid) throw new Error("user_id が空やで");

    setProvLoading(true);
    setProvMsg(null);
    try {
      const res = await apiFetch("/api/admin/provision-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: uid, email: email || undefined }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);

      setProvMsg(json.created ? "作成した（public.usersに追加）" : "既に存在（補完のみ or 変更なし）");
      setProvUserId("");
      setProvEmail("");

      // ついでに usage を再取得（表示更新）
      const res2 = await apiFetch(`/api/admin/usage?month=${encodeURIComponent(month)}`);
      const json2 = await res2.json().catch(() => null);
      if (!res2.ok || !json2?.ok) throw new Error(json2?.error ?? `HTTP ${res2.status}`);
      setRows((json2.data ?? []) as Row[]);
    } finally {
      setProvLoading(false);
    }
  }

  useEffect(() => {
    loadAllowlist().catch((e: any) => setErr(e?.message ?? String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => (r.users?.email ?? "").toLowerCase().includes(needle));
  }, [rows, q]);

  function computed(r: Row) {
    const used = r.used_talks ?? 0;
    const limit = r.limit_talks; // null = 無制限の可能性はあるが、usage表側は通常nullになりにくい
    const remaining =
      limit === null ? null : Math.max((limit ?? 0) - used, 0);

    const pct =
      limit === null || !limit || limit <= 0 ? null : Math.min(1, Math.max(0, used / limit));

    const monthsActive = diffMonthsInclusive(r.users?.created_at ?? null, month);

    const plan = (r.users?.plan ?? "free") as string;
    const revenue = priceFor(plan);

    return { used, limit, remaining, pct, monthsActive, revenue, plan };
  }

  const sorted = useMemo(() => {
    const arr = [...filtered];

    const getVal = (r: Row): any => {
      const c = computed(r);
      switch (sortKey) {
        case "email":
          return (r.users?.email ?? "").toLowerCase();
        case "plan":
          return String(c.plan ?? "");
        case "monthly_quota":
          return Number(r.users?.monthly_quota ?? 0);
        case "month":
          return r.month;
        case "used_talks":
          return c.used;
        case "limit_talks":
          // nullは最大/最小のどっちに寄せるか迷うので、とりあえず -1 扱い（下に落ちる）
          return c.limit === null ? -1 : Number(c.limit ?? 0);
        case "remaining":
          return c.remaining === null ? Number.POSITIVE_INFINITY : Number(c.remaining ?? 0);
        case "pct":
          return c.pct === null ? -1 : c.pct;
        case "months_active":
          return c.monthsActive === null ? -1 : c.monthsActive;
        case "revenue_yen":
          return c.revenue;
        case "updated_at":
          return r.updated_at ? new Date(r.updated_at).getTime() : 0;
        default:
          return 0;
      }
    };

    arr.sort((a, b) => {
      const va = getVal(a);
      const vb = getVal(b);
      if (va < vb) return sortDir === "asc" ? -1 : 1;
      if (va > vb) return sortDir === "asc" ? 1 : -1;
      return 0;
    });

    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sortKey, sortDir, month]);

  const summary = useMemo(() => {
    const byPlan: Record<string, { users: number; revenue: number; usedSum: number }> = {};
    let totalRevenue = 0;

    for (const r of sorted) {
      const c = computed(r);
      const planKey = String(c.plan ?? "free").toLowerCase();

      if (!byPlan[planKey]) byPlan[planKey] = { users: 0, revenue: 0, usedSum: 0 };
      byPlan[planKey].users += 1;
      byPlan[planKey].revenue += c.revenue;
      byPlan[planKey].usedSum += c.used;

      totalRevenue += c.revenue;
    }

    const plans = Object.entries(byPlan)
      .sort((a, b) => b[1].revenue - a[1].revenue)
      .map(([k, v]) => ({ plan: k, ...v }));

    return { totalRevenue, plans };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sorted]);

  const authHint =
    status === 401
      ? "ログインしてへんっぽい。/login してから開いてな。"
      : status === 403
      ? "権限なし（管理者のみ）"
      : null;

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const th = (key: SortKey, label: string) => (
    <th
      key={key}
      onClick={() => toggleSort(key)}
      style={{
        cursor: "pointer",
        textAlign: "left",
        fontSize: 12,
        padding: "10px 12px",
        borderBottom: "1px solid #eee",
        whiteSpace: "nowrap",
        userSelect: "none",
      }}
      title="クリックでソート"
    >
      {label}
      {sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
    </th>
  );

  return (
    <main style={{ padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 900 }}>Admin / Usage</h1>
          <p style={{ marginTop: 6, opacity: 0.7 }}>
            month = <b>{month}</b>（used_talks を正として表示）
          </p>
          <p style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>
            想定売上（フィルタ後の行ベース）: <b>{fmtYen(summary.totalRevenue)}</b>
          </p>
          {summary.plans.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
              {summary.plans.map((p) => (
                <div key={p.plan}>
                  {p.plan}: {fmtYen(p.revenue)}（{p.users}人 / used合計 {p.usedSum}）
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 12, opacity: 0.7 }}>月</span>
            <input
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              placeholder="YYYY-MM"
              style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd", width: 110 }}
            />
          </label>

          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 12, opacity: 0.7 }}>email検索</span>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="例: gladplan"
              style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd", width: 220 }}
            />
          </label>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        {authHint && (
          <div style={{ padding: 12, borderRadius: 12, background: "#fff7e6", border: "1px solid #ffd59e", marginBottom: 12 }}>
            {authHint}
          </div>
        )}

        {err && !authHint && (
          <div style={{ padding: 12, borderRadius: 12, background: "#fff3f3", border: "1px solid #ffd1d1", color: "#a10000", marginBottom: 12 }}>
            Error: {err}
          </div>
        )}

        <div style={{ overflowX: "auto", border: "1px solid #eee", borderRadius: 12 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1200 }}>
            <thead>
              <tr style={{ background: "#fafafa" }}>
                {th("email", "email")}
                {th("plan", "plan")}
                {th("revenue_yen", "revenue_yen")}
                {th("months_active", "months_active")}
                {th("monthly_quota", "monthly_quota")}
                {th("month", "month")}
                {th("used_talks", "used_talks")}
                {th("limit_talks", "limit_talks")}
                {th("remaining", "remaining")}
                {th("pct", "pct")}
                {th("updated_at", "updated_at")}
              </tr>
            </thead>

            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={11} style={{ padding: 14, opacity: 0.7 }}>
                    読み込み中…
                  </td>
                </tr>
              ) : sorted.length === 0 ? (
                <tr>
                  <td colSpan={11} style={{ padding: 14, opacity: 0.7 }}>
                    データなし
                  </td>
                </tr>
              ) : (
                sorted.map((r) => {
                  const c = computed(r);
                  const email = r.users?.email ?? "(no email)";
                  const plan = r.users?.plan ?? "-";
                  const quota = r.users?.monthly_quota ?? "-";
                  const used = c.used;
                  const limitDisp = c.limit === null ? "∞" : String(c.limit ?? 0);
                  const remDisp = c.remaining === null ? "∞" : String(c.remaining ?? 0);
                  const pctDisp = c.pct === null ? "-" : `${Math.round(c.pct * 100)}%`;
                  const monthsDisp = c.monthsActive === null ? "-" : String(c.monthsActive);
const uid = r.user_id;
                  const currentPlan = String(r.users?.plan ?? "free").toLowerCase();
                  const draft = planDraft[uid] ?? currentPlan;
                  const saving = Boolean(planSaving[uid]);
                  

                  return (
                    <tr key={`${r.user_id}-${r.month}`}>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid #f0f0f0" }}>{email}</td>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid #f0f0f0" }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <select
                            value={draft}
                            onChange={(e) => setPlanDraft((m) => ({ ...m, [uid]: e.target.value }))}
                            style={{ padding: "6px 8px", borderRadius: 10, border: "1px solid #ddd" }}
                            title={`現在: ${currentPlan}`}
                          >
                            <option value="free">free</option>
                            <option value="lite">lite</option>
                            <option value="standard">standard</option>
                            <option value="enterprise">enterprise</option>
                          </select>

                          <button
                            type="button"
                            disabled={saving || draft === currentPlan}
                            onClick={() =>
                              saveUserPlan(uid, draft).catch((e: any) => setErr(e?.message ?? String(e)))
                            }
                            style={{
                              padding: "6px 10px",
                              borderRadius: 10,
                              border: "1px solid #ddd",
                              background: "white",
                              fontWeight: 800,
                              opacity: saving || draft === currentPlan ? 0.5 : 1,
                            }}
                          >
                            保存
                          </button>
                        </div>
                      </td>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid #f0f0f0" }}>{fmtYen(c.revenue)}</td>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid #f0f0f0" }}>{monthsDisp}</td>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid #f0f0f0" }}>{quota}</td>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid #f0f0f0" }}>{r.month}</td>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid #f0f0f0" }}>{used}</td>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid #f0f0f0" }}>{limitDisp}</td>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid #f0f0f0" }}>
                        <b>{remDisp}</b>
                      </td>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid #f0f0f0" }}>{pctDisp}</td>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid #f0f0f0", whiteSpace: "nowrap" }}>
                        {r.updated_at ? new Date(r.updated_at).toLocaleString() : "-"}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* ===== 友だち追加（Auth UID → public.users 同期） ===== */}
        <section style={{ marginTop: 18 }}>
          <h2 style={{ fontSize: 16, fontWeight: 900 }}>ユーザー同期（友だち無料の準備）</h2>
          <p style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
            Supabase Authentication → Users の UID（uuid）を貼って、public.users に行を作る（初期free / quota=0）。
          </p>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10, alignItems: "center" }}>
            <input
              value={provUserId}
              onChange={(e) => setProvUserId(e.target.value)}
              placeholder="user_id (Auth UID / uuid)"
              style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd", width: 360 }}
            />
            <input
              value={provEmail}
              onChange={(e) => setProvEmail(e.target.value)}
              placeholder="email（任意：補完用）"
              style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd", width: 320 }}
            />
            <button
              type="button"
              disabled={provLoading}
              onClick={() => provisionUser().catch((e: any) => setErr(e?.message ?? String(e)))}
              style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd", background: "white", fontWeight: 800 }}
            >
              ユーザー同期
            </button>
          </div>

          {provMsg && (
            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>
              結果: <b>{provMsg}</b>
            </div>
          )}
        </section>

        {/* ===== 無制限 allowlist（同一画面） ===== */}
        <section style={{ marginTop: 18 }}>
          <h2 style={{ fontSize: 16, fontWeight: 900 }}>無制限 allowlist</h2>
          <p style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
            無制限（usage消費スキップ）対象。label に staff / client 等を書いておく。
          </p>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10, alignItems: "center" }}>
            <input
              value={allowUserId}
              onChange={(e) => setAllowUserId(e.target.value)}
              placeholder="user_id (uuid)"
              style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd", width: 320 }}
            />
            <input
              value={allowLabel}
              onChange={(e) => setAllowLabel(e.target.value)}
              placeholder="label 例: staff:山田 / client:◯◯社"
              style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd", width: 360 }}
            />
            <button
              type="button"
              onClick={() => upsertAllowlist().catch((e: any) => setErr(e?.message ?? String(e)))}
              style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd", background: "white", fontWeight: 800 }}
            >
              追加/更新
            </button>
            <button
              type="button"
              onClick={() => loadAllowlist().catch((e: any) => setErr(e?.message ?? String(e)))}
              style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd", background: "white" }}
            >
              再読込
            </button>
          </div>

          <div style={{ marginTop: 10, border: "1px solid #eee", borderRadius: 12, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
              <thead>
                <tr style={{ background: "#fafafa" }}>
                  {["email", "user_id", "label", "created_at", ""].map((h) => (
                    <th
                      key={h}
                      style={{ textAlign: "left", fontSize: 12, padding: "10px 12px", borderBottom: "1px solid #eee", whiteSpace: "nowrap" }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {allowLoading ? (
                  <tr>
                    <td colSpan={5} style={{ padding: 14, opacity: 0.7 }}>
                      読み込み中…
                    </td>
                  </tr>
                ) : allowRows.length === 0 ? (
                  <tr>
                    <td colSpan={5} style={{ padding: 14, opacity: 0.7 }}>
                      データなし
                    </td>
                  </tr>
                ) : (
                  allowRows.map((r) => (
                    <tr key={r.user_id}>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid #f0f0f0" }}>{r.email ?? "-"}</td>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid #f0f0f0", fontFamily: "monospace" }}>{r.user_id}</td>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid #f0f0f0" }}>{r.label ?? "-"}</td>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid #f0f0f0", whiteSpace: "nowrap" }}>
                        {r.created_at ? new Date(r.created_at).toLocaleString() : "-"}
                      </td>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid #f0f0f0" }}>
                        <button
                          type="button"
                          style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd", background: "white" }}
                          onClick={() => {
                            if (confirm("この user_id を無制限から外す？")) {
                              deleteAllowlist(r.user_id).catch((e: any) => setErr(e?.message ?? String(e)));
                            }
                          }}
                        >
                          削除
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <p style={{ marginTop: 12, fontSize: 12, opacity: 0.7 }}>
        ※ month は "YYYY-MM"。当月以外を見るときは手入力でOK（例: 2026-02）
      </p>
      <p style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>
        ※ 想定売上は PLAN_PRICE_YEN の固定マップ。正式値に合わせて数字だけ差し替え。
      </p>
    </main>
  );
}
