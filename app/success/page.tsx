"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function SuccessPage() {
  const router = useRouter();
  const [sec, setSec] = useState(5);

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
