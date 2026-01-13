"use client";

import { useState } from "react";

export default function ChatPage() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<string[]>([]);

  const send = () => {
    if (!input) return;
    setMessages((prev) => [...prev, "あなた: " + input]);
    setInput("");
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
          <div style={{ color: "#888" }}>
            ここに相談内容を入力してください。
          </div>
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
        />
        <button
          onClick={send}
          style={{
            padding: "10px 16px",
            background: "#000",
            color: "#fff",
            borderRadius: 6,
          }}
        >
          送信
        </button>
      </div>
    </main>
  );
}
