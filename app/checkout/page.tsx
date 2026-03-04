// app/checkout/page.tsx
"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getSupabaseClient } from "@/app/lib/supabaseClient";

const ALLOWED = new Set(["lite", "standard", "enterprise"]);

function CheckoutInner() {
  const supabase = useMemo(() => getSupabaseClient(), []);
  const sp = useSearchParams();
  const [msg, setMsg] = useState("決済画面を開いています…");

  useEffect(() => {
    const planRaw = String(sp.get("plan") ?? "").toLowerCase();
    const plan = ALLOWED.has(planRaw) ? planRaw : "";

    if (!plan) {
      window.location.href = "/";
      return;
    }

    (async () => {
       // ✅ 認証直後のcookie反映遅延に備えて1回だけリトライ
      let token = "";
      for (let i = 0; i < 2; i++) {
        const { data } = await supabase.auth.getSession();
        token = data.session?.access_token ?? "";
        if (token) break;
        await new Promise((r) => setTimeout(r, 250));
      }

      if (!token) {
        window.location.href = `/login?plan=${encodeURIComponent(plan)}`;
        return;
      }

      try {
        const res = await fetch("/api/create-checkout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ plan }),
        });

        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.ok || !json?.url) {
          throw new Error(json?.error || "決済ページの作成に失敗しました。");
        }

        window.location.href = json.url;
      } catch (e: any) {
        setMsg(e?.message ?? "決済ページの作成に失敗しました。");
      }
    })();
  }, [sp, supabase]);

  return (
    <div style={{ maxWidth: 720, margin: "24px auto", padding: "0 16px" }}>
      <h1 style={{ fontSize: 20, fontWeight: 800, marginBottom: 12 }}>決済</h1>
      <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16 }}>
        <p style={{ margin: 0 }}>{msg}</p>
      </div>
    </div>
  );
}

export default function CheckoutPage() {
  return (
    <Suspense fallback={<div />}>
      <CheckoutInner />
    </Suspense>
  );
}