"use client";

import { useState } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type ChatMsg = { role: "user" | "assistant"; text: string };

export default function ChatPage() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [sending, setSending] = useState(false);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;

    setSending(true);
    setMessages((prev) => [...prev, { role: "user", text }]);
    setInput("");

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        window.location.href = "/login";
        return;
      }

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ message: text }),
      });

      const data = await res.json();

      if (!res.ok) {
        // quota超過はここに来る
        const msg =
          data?.error === "quota exceeded"
            ? `今月の上限です（${data.used_talks}/${data.limit_talks}）。プラン変更をご検討ください。`
            : data?.error ?? "エラーが発生しました";

        setMessages((prev) => [...prev, { role: "assistant", text: msg }]);
        return;
      }

      setMessages((prev) => [...prev, { role: "assistant", text: data.reply }]);
    } catch (e) {
      console.error(e);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: "通信エラーです。もう一回やってみて。" },
      ]);
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
            <b>{m.role === "user" ? "あなた" : "AI"}:</b> {m.text}
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
          disabled={sending}
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
          {sending ? "送信中…" : "送信"}
        </button>
      </div>
    </main>
  );
}
