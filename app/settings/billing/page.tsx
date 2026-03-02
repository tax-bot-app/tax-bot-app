"use client";

import { useMemo, useState } from "react";
import { getSupabaseClient } from "@/app/lib/supabaseClient";

export default function BillingSettingsPage() {
  const supabase = useMemo(() => getSupabaseClient(), []);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const openPortal = async () => {
    setLoading(true);
    setMsg(null);

    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;

      const token = data.session?.access_token;
      if (!token) throw new Error("Not logged in");

      const res = await fetch("/api/stripe/portal", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      const json = await res.json();
      if (!res.ok || !json?.ok) {
        throw new Error(json?.error || "Failed to create portal session");
      }

      window.location.href = json.url;
    } catch (e: any) {
      setMsg(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    setLoading(true);
    setMsg(null);
    try {
      await supabase.auth.signOut();
      window.location.href = "/login";
    } catch (e: any) {
      setMsg(e?.message ?? String(e));
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 720, margin: "24px auto", padding: "0 16px" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 12 }}>
        請求設定
      </h1>

      <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16 }}>
        <p style={{ margin: "0 0 12px 0" }}>
          カード変更・解約・請求履歴の確認はStripeの公式画面で行います。
        </p>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            onClick={openPortal}
            disabled={loading}
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #111827",
              background: loading ? "#f3f4f6" : "#111827",
              color: loading ? "#111827" : "#ffffff",
              cursor: loading ? "not-allowed" : "pointer",
              fontWeight: 700,
            }}
          >
            {loading ? "開いてます…" : "請求設定を開く（カード/解約）"}
          </button>

          <button
            onClick={logout}
            disabled={loading}
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #ef4444",
              background: "#ffffff",
              color: "#ef4444",
              cursor: loading ? "not-allowed" : "pointer",
              fontWeight: 700,
            }}
          >
            ログアウト
          </button>
        </div>

        {msg && <p style={{ marginTop: 12, color: "#b91c1c" }}>{msg}</p>}
      </div>
    </div>
  );
}
