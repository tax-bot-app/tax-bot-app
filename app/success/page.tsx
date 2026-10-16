"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { trackPurchase } from "../lib/metaPixel";
import {
  trackOpenAIOrderCreatedOnce,
  trackOpenAISubscriptionCreatedOnce,
} from "../lib/openaiAds";
import { getSupabaseClient } from "../lib/supabaseClient";

type SinglePurchaseResult = {
  confirmed?: boolean;
  pending?: boolean;
  balance?: number;
  creditsAdded?: number;
  amount?: number;
  currency?: string;
  conversionId?: string;
};

function SuccessInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session_id") ?? "";
  const isSinglePurchase = searchParams.get("purchase") === "single";
  const [sec, setSec] = useState(5);
  const [singleConfirmed, setSingleConfirmed] = useState(false);
  const [singleResult, setSingleResult] = useState<SinglePurchaseResult | null>(
    null
  );
  const [singleDelayed, setSingleDelayed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    if (!isSinglePurchase) {
      // 月額の既存Meta計測は維持し、単発購入ではここを通さない。
      trackPurchase();
    }
    if (!sessionId) return;

    const confirmPurchase = async () => {
      const supabase = getSupabaseClient();
      let token = "";
      for (let i = 0; i < 2; i++) {
        const { data } = await supabase.auth.getSession();
        token = data.session?.access_token ?? "";
        if (token) break;
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
      if (!token || cancelled) return;

      if (isSinglePurchase) {
        for (let attempt = 0; attempt < 20 && !cancelled; attempt++) {
          const response = await fetch("/api/single-credits/purchase-status", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ sessionId }),
          });
          const result = (await response.json().catch(() => null)) as
            | SinglePurchaseResult
            | null;

          if (response.ok && result?.confirmed && result.conversionId) {
            if (cancelled) return;
            setSingleResult(result);
            setSingleConfirmed(true);
            trackPurchase({
              value: result.amount,
              currency: result.currency ?? "JPY",
              plan: "single_credit",
              transaction_id: result.conversionId,
            });
            for (let i = 0; i < 3 && !cancelled; i++) {
              if (
                trackOpenAIOrderCreatedOnce(
                  result.conversionId,
                  Number(result.amount ?? 0)
                )
              ) {
                break;
              }
              await new Promise((resolve) => window.setTimeout(resolve, 250));
            }
            return;
          }

          await new Promise((resolve) => window.setTimeout(resolve, 500));
        }
        if (!cancelled) setSingleDelayed(true);
        return;
      }

      const response = await fetch(
        "/api/openai-ads/subscription-confirmation",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ sessionId }),
        }
      );
      const result = (await response.json().catch(() => null)) as {
        confirmed?: boolean;
        conversionId?: string;
      } | null;

      if (!response.ok || !result?.confirmed || !result.conversionId) return;

      for (let i = 0; i < 3 && !cancelled; i++) {
        if (trackOpenAISubscriptionCreatedOnce(result.conversionId)) return;
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
    };

    void confirmPurchase().catch(() => {
      // 広告計測・状態確認に失敗しても、決済完了画面そのものは止めない。
      if (isSinglePurchase && !cancelled) setSingleDelayed(true);
    });

    return () => {
      cancelled = true;
    };
  }, [isSinglePurchase, sessionId]);

  const canRedirect = !isSinglePurchase || singleConfirmed;

  useEffect(() => {
    if (!canRedirect) return;

    const tick = window.setInterval(() => {
      setSec((current) => (current > 0 ? current - 1 : 0));
    }, 1000);
    const go = window.setTimeout(() => router.push("/chat"), 5000);

    return () => {
      window.clearInterval(tick);
      window.clearTimeout(go);
    };
  }, [canRedirect, router]);

  const heading = singleDelayed
    ? "決済完了・反映確認中"
    : isSinglePurchase && !singleConfirmed
      ? "決済を確認しています…"
      : "申込完了 🎉";

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <div style={{ textAlign: "center", maxWidth: 520, padding: "0 16px" }}>
        <h1 style={{ fontSize: 32, fontWeight: 800 }}>{heading}</h1>

        <p style={{ marginTop: 12, lineHeight: 1.7 }}>
          {isSinglePurchase && !singleConfirmed ? (
            singleDelayed ? (
              <>
                お支払いは完了しています。クレジット反映に時間がかかっています。
                <br />
                少し待ってから相談画面で残数をご確認ください。
              </>
            ) : (
              <>お支払いとクレジット付与を確認しています。そのままお待ちください。</>
            )
          ) : (
            <>
              決済が完了しました。ありがとうございます。
              {isSinglePurchase && singleResult ? (
                <>
                  <br />
                  <b>{singleResult.creditsAdded}回分</b>を追加しました。残り
                  <b>{singleResult.balance}回</b>です。
                </>
              ) : null}
              <br />
              <b>{sec}秒後</b>に自動で相談画面に切り替わります。
            </>
          )}
        </p>

        <Link
          href="/chat"
          style={{
            display: "inline-block",
            marginTop: 24,
            padding: "14px 28px",
            backgroundColor: "#000",
            color: "#fff",
            borderRadius: 12,
            textDecoration: "none",
            fontWeight: 800,
          }}
        >
          いますぐ「さじかげん」に相談する →
        </Link>

        <p style={{ marginTop: 14, fontSize: 12, opacity: 0.7 }}>
          ※ 自動で切り替わらない場合は、上のボタンを押してください
        </p>
      </div>
    </main>
  );
}

export default function SuccessPage() {
  return (
    <Suspense fallback={<div />}>
      <SuccessInner />
    </Suspense>
  );
}
