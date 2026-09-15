"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { trackPurchase } from "../lib/metaPixel";
import { trackOpenAISubscriptionCreatedOnce } from "../lib/openaiAds";
import { getSupabaseClient } from "../lib/supabaseClient";

export default function SuccessPage() {
  const router = useRouter();
  const [sec, setSec] = useState(5);

  useEffect(() => {
    trackPurchase();
  }, []);

  useEffect(() => {
    let cancelled = false;

    const confirmSubscription = async () => {
      const sessionId = new URLSearchParams(window.location.search).get(
        "session_id"
      );
      if (!sessionId) return;

      const supabase = getSupabaseClient();
      let token = "";
      for (let i = 0; i < 2; i++) {
        const { data } = await supabase.auth.getSession();
        token = data.session?.access_token ?? "";
        if (token) break;
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
      if (!token || cancelled) return;

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

    void confirmSubscription().catch(() => {
      // 広告計測に失敗しても申込完了画面と既存導線は止めない。
    });

    return () => {
      cancelled = true;
    };
  }, []);

  // ✅ 5秒カウントダウン → /chat へ自動遷移
  useEffect(() => {
    const tick = setInterval(() => {
      setSec((s) => (s > 0 ? s - 1 : 0));
    }, 1000);

    const go = setTimeout(() => {
      router.push("/chat");
    }, 5000);

    return () => {
      clearInterval(tick);
      clearTimeout(go);
    };
  }, [router]);

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <div style={{ textAlign: "center", maxWidth: 520, padding: "0 16px" }}>
        <h1 style={{ fontSize: 32, fontWeight: 800 }}>申込完了 🎉</h1>

        <p style={{ marginTop: 12, lineHeight: 1.7 }}>
          決済が完了しました。ありがとうございます。
          <br />
          <b>{sec}秒後</b>に自動で相談画面に切り替わります。
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
