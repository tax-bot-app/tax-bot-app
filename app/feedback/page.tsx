"use client";

import Link from "next/link";

export default function FeedbackPage() {
  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "24px 16px 80px" }}>
      <div style={{ marginBottom: 16 }}>
        <Link href="/chat" style={{ color: "#555", textDecoration: "none" }}>
          ← チャットに戻る
        </Link>
      </div>

      <h1 style={{ fontSize: 28, fontWeight: 900, marginBottom: 12 }}>
        送信履歴
      </h1>

      <div
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 14,
          padding: 16,
          background: "#fafafa",
          color: "#333",
          lineHeight: 1.8,
          fontSize: 14,
          marginBottom: 18,
        }}
      >
        ここでは、ご自身が送信したお問い合わせ・要望・回答報告の履歴を確認できます。
      </div>

      <div
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 14,
          padding: 20,
          textAlign: "center",
          color: "#666",
        }}
      >
        まだ送信履歴はありません。
      </div>

      <div style={{ marginTop: 18 }}>
        <Link
          href="/feedback/new"
          style={{
            display: "inline-block",
            padding: "12px 18px",
            borderRadius: 12,
            border: "1px solid #111",
            background: "#111",
            color: "#fff",
            fontWeight: 800,
            textDecoration: "none",
          }}
        >
          新しく送る
        </Link>
      </div>
    </main>
  );
}