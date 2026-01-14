"use client";

import { useState } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type ChatRes =
  | {
      ok: true;
      plan: string;
      used_talks: number | null;
      limit_talks: number | null;
      reply: string;
    }
  | {
      error: string;
      plan?: string;
      used_talks?: number | null;
      limit_talks?: number | null;
    };

export default function ChatPage() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<string[]>([]);
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (!input || sending) return;

    const text = input;
    setInput("");
    setMessages((prev) => [...prev, `あなた: ${text}`]);

    setSending(true);
    try {
      // ① ログインセッション（Bearerトークン）取得
      const {
        data: { session },
        error: sessionErr,
      } = await supabase.auth.getSession();

      if (sessionErr || !session?.access_token) {
        window.location.href = "/login";
        return;
      }

      const accessToken = session.access_token;

      // ② /api/chat を Bearer付きで叩く
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ message: text }),
      });

      const data = (await res.json()) as ChatRes;

      if (!res.ok) {
        // 回数制限（402想定）
        const msg =
          data?.error === "quota exceeded"
            ? `AI: 回数上限です（${data.used_talks ?? "?"}/${data.limit_talks ?? "?"}）`
            : `AI: ${data?.error ?? "chat error"}`;
        setMessages((prev) => [...prev, msg]);
        return;
      }

      setMessages((prev) => [...prev, `AI: ${data.reply}`]);
    } catch (e) {
      console.error(e);
      setMessages((prev) => [...prev, "AI: 予期せぬエラー"]);
    } finally {
      setSending(false);
    }
  };

  return (
    <main style={{ maxWidth: 720, margin: "40px auto", padding: "0 16px" }}>
      <h1 style={{ fontSize: 24, fontWeight: 700 }}>税務相談チャット</h1>

      <div
        style={{
          marginTop: 16,
          border: "1px solid #ddd",
          borderRadius: 8,
          padding: 12,
          minHeight: 300,
        }}
      >
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 8 }}>
            {m}
          </div>
        ))}
        {messages.length === 0 && (
          <div style={{ color: "#888" }}>ここに相談内容を入力してください。</div>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="例：ゴルフのウェアって経費になりますか？"
          style={{
            flex: 1,
            padding: "10px 12px",
            borderRadius: 6,
            border: "1px solid #ccc",
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
        />
        <button
          onClick={send}
          disabled={sending}
          style={{
            padding: "10px 16px",
            background: "#000",
            color: "#fff",
            borderRadius: 6,
            opacity: sending ? 0.6 : 1,
          }}
        >
          {sending ? "送信中" : "送信"}
        </button>
      </div>
    </main>
  );
}
