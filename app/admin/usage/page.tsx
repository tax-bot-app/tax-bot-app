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
  } | null;
};

function currentMonthKeyJST(): string {
  const d = new Date();
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 7);
}

export default function AdminUsagePage() {
  const supabase = useMemo(() => getSupabaseClient(), []);

  const [month, setMonth] = useState(currentMonthKeyJST());
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<number | null>(null);

  async function tokenOrThrow(): Promise<string> {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;

    const t = data.session?.access_token;
    if (!t) throw new Error("Not logged in. 先に /login してな。");
    return t;
  }

  async function apiFetch(path: string) {
    const token = await tokenOrThrow();
    return fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  }

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErr(null);
      setStatus(null);

      try {
        const res = await apiFetch(
          `/api/admin/usage?month=${encodeURIComponent(month)}`
        );
        setStatus(res.status);

        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.ok) {
          throw new Error(json?.error ?? `HTTP ${res.status}`);
        }

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

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) =>
      (r.users?.email ?? "").toLowerCase().includes(needle)
    );
  }, [rows, q]);

  const authHint =
    status === 401
      ? "ログインしてへんっぽい。/login してから開いてな。"
      : status === 403
      ? "権限なし（管理者のみ）"
      : null;

  return (
    <main style={{ padding: 24 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 900 }}>Admin / Usage</h1>
          <p style={{ marginTop: 6, opacity: 0.7 }}>
            month = <b>{month}</b>（used_talks を正として表示）
          </p>
        </div>

        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 12, opacity: 0.7 }}>月</span>
            <input
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              placeholder="YYYY-MM"
              style={{
                padding: "8px 10px",
                borderRadius: 10,
                border: "1px solid #ddd",
                width: 110,
              }}
            />
          </label>

          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 12, opacity: 0.7 }}>email検索</span>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="例: gladplan"
              style={{
                padding: "8px 10px",
                borderRadius: 10,
                border: "1px solid #ddd",
                width: 220,
              }}
            />
          </label>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        {authHint && (
          <div
            style={{
              padding: 12,
              borderRadius: 12,
              background: "#fff7e6",
              border: "1px solid #ffd59e",
              marginBottom: 12,
            }}
          >
            {authHint}
          </div>
        )}

        {err && !authHint && (
          <div
            style={{
              padding: 12,
              borderRadius: 12,
              background: "#fff3f3",
              border: "1px solid #ffd1d1",
              color: "#a10000",
              marginBottom: 12,
            }}
          >
            Error: {err}
          </div>
        )}

        <div
          style={{
            overflowX: "auto",
            border: "1px solid #eee",
            borderRadius: 12,
          }}
        >
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
            <thead>
              <tr style={{ background: "#fafafa" }}>
                {[
                  "email",
                  "plan",
                  "monthly_quota",
                  "month",
                  "used_talks",
                  "limit_talks",
                  "remaining",
                  "updated_at",
                ].map((h) => (
                  <th
                    key={h}
                    style={{
                      textAlign: "left",
                      fontSize: 12,
                      padding: "10px 12px",
                      borderBottom: "1px solid #eee",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} style={{ padding: 14, opacity: 0.7 }}>
                    読み込み中…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ padding: 14, opacity: 0.7 }}>
                    データなし
                  </td>
                </tr>
              ) : (
                filtered.map((r) => {
                  const used = r.used_talks ?? 0;
                  const limit = r.limit_talks ?? 0;
                  const remaining = Math.max(limit - used, 0);

                  return (
                    <tr key={`${r.user_id}-${r.month}`}>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid #f0f0f0" }}>
                        {r.users?.email ?? "(no email)"}
                      </td>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid #f0f0f0" }}>
                        {r.users?.plan ?? "-"}
                      </td>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid #f0f0f0" }}>
                        {r.users?.monthly_quota ?? "-"}
                      </td>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid #f0f0f0" }}>
                        {r.month}
                      </td>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid #f0f0f0" }}>
                        {used}
                      </td>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid #f0f0f0" }}>
                        {limit}
                      </td>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid #f0f0f0" }}>
                        <b>{remaining}</b>
                      </td>
                      <td
                        style={{
                          padding: "10px 12px",
                          borderBottom: "1px solid #f0f0f0",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {r.updated_at ? new Date(r.updated_at).toLocaleString() : "-"}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p style={{ marginTop: 12, fontSize: 12, opacity: 0.7 }}>
        ※ month は "YYYY-MM"。当月以外を見るときは手入力でOK（例: 2026-02）
      </p>
    </main>
  );
}
