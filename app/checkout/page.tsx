// app/checkout/page.tsx
"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getSupabaseClient } from "@/app/lib/supabaseClient";
import { trackOpenAICheckoutStarted } from "@/app/lib/openaiAds";
import { isSinglePurchaseKey } from "@/app/lib/singlePurchase";

const ALLOWED = new Set(["lite", "standard", "enterprise"]);

function CheckoutInner() {
  const supabase = useMemo(() => getSupabaseClient(), []);
  const sp = useSearchParams();
  const [msg, setMsg] = useState("決済画面を開いています…");
  const checkoutMeasuredRef = useRef(false);
  const attemptIdRef = useRef("");

  useEffect(() => {
    const planRaw = String(sp.get("plan") ?? "").toLowerCase();
    const plan = ALLOWED.has(planRaw) ? planRaw : "";
    const purchaseRaw = String(sp.get("purchase") ?? "").toLowerCase();
    const purchase = isSinglePurchaseKey(purchaseRaw) ? purchaseRaw : "";

    if ((!plan && !purchase) || (plan && purchase)) {
      window.location.href = "/";
      return;
    }

    if (!attemptIdRef.current) {
      attemptIdRef.current = crypto.randomUUID();
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
        const query = plan
          ? `plan=${encodeURIComponent(plan)}`
          : `purchase=${encodeURIComponent(purchase)}`;
        window.location.href = `/login?${query}`;
        return;
      }

      try {
        const res = await fetch(
          purchase ? "/api/create-single-checkout" : "/api/create-checkout",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(
              purchase
                ? { purchase, attemptId: attemptIdRef.current }
                : { plan }
            ),
          }
        );

        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.ok || !json?.url) {
          throw new Error(json?.error || "決済ページの作成に失敗しました。");
        }

        if (!checkoutMeasuredRef.current) {
          trackOpenAICheckoutStarted();
          checkoutMeasuredRef.current = true;
        }
        window.location.href = json.url;
      } catch (error: unknown) {
        setMsg(
          error instanceof Error
            ? error.message
            : "決済ページの作成に失敗しました。"
        );
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
