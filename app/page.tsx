"use client";

import { useMemo, useState } from "react";
import { getSupabaseClient } from "./lib/supabaseClient";

type Plan = "lite" | "standard" | "enterprise";

const PLANS: Array<{
  key: Plan;
  title: string;
  priceLabel: string;
  quotaLabel: string;
}> = [
  { key: "lite", title: "Lite", priceLabel: "3,300円/月", quotaLabel: "月5回まで" },
  { key: "standard", title: "Standard", priceLabel: "16,500円/月", quotaLabel: "月20回まで" },
  { key: "enterprise", title: "Enterprise", priceLabel: "33,000円/月", quotaLabel: "月100回まで" },
];

type CheckoutRes = { ok: true; url: string } | { ok: false; error: string };

export default function Home() {
  const [busy, setBusy] = useState<Plan | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  const supabase = useMemo(() => {
    try {
      return getSupabaseClient();
    } catch (e: any) {
      setFatal(
        `環境変数が足りません：${e?.message ?? String(e)}\n` +
          `VercelのEnvironment Variablesに NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を入れて、Redeployしてください。`
      );
      return null;
    }
  }, []);

  const goCheckout = async (plan: Plan) => {
    if (!supabase) return;

    setBusy(plan);
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session?.access_token) {
        window.location.href = "/login";
        return;
      }

      const res = await fetch("/api/create-checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${data.session.access_token}`,
        },
        body: JSON.stringify({ plan }),
      });

      const json = (await res.json().catch(() => null)) as CheckoutRes | null;

      if (!json) throw new Error("create-checkout: empty response");
      if (!json.ok) throw new Error(json.error || "create-checkout failed");
      if (!json.url) throw new Error("create-checkout: url missing");

      window.location.href = json.url;
    } catch (e: any) {
      alert(`決済に進めません：${e?.message ?? String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <main style={{ maxWidth: 780, margin: "40px auto", padding: 16 }}>
      <h1 style={{ textAlign: "center", marginBottom: 6 }}>税務相談AI（テスト版）</h1>
      <p style={{ textAlign: "center", color: "#666", marginTop: 0 }}>
        月額プランで税務相談ができます（回数制限あり）。プランを選んでお申し込みください。
      </p>

      {fatal && (
        <div
          style={{
            border: "1px solid #f99",
            background: "#fff5f5",
            padding: 12,
            borderRadius: 10,
            whiteSpace: "pre-wrap",
            marginTop: 12,
          }}
        >
          {fatal}
        </div>
      )}

      <div style={{ display: "grid", gap: 12, marginTop: 18 }}>
        {PLANS.map((p) => (
          <button
            key={p.key}
            onClick={() => goCheckout(p.key)}
            disabled={!supabase || busy !== null}
            style={{
              textAlign: "left",
              padding: 16,
              borderRadius: 12,
              border: "1px solid #ddd",
              background: "#111",
              color: "#fff",
              opacity: !supabase || busy !== null ? 0.6 : 1,
              cursor: !supabase || busy !== null ? "not-allowed" : "pointer",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>{p.title}</div>
                <div style={{ fontSize: 13, opacity: 0.85 }}>{p.quotaLabel}</div>
              </div>
              <div style={{ fontSize: 14, opacity: 0.9 }}>{p.priceLabel}</div>
            </div>

            {busy === p.key && <div style={{ marginTop: 10, opacity: 0.85 }}>決済ページを開いています…</div>}
          </button>
        ))}
      </div>

      <p style={{ textAlign: "center", color: "#666", marginTop: 14, fontSize: 12 }}>
        ※ ログインしていない場合はログイン画面に移動します
      </p>
    </main>
  );
}
