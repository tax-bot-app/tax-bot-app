"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type ChatRes =
  | {
      ok: true;
      plan: string;
      used_talks: number | null;
      limit_talks: number | null;
      message: string;
    }
  | {
      ok: false;
      error: string;
      used_talks?: number | null;
      limit_talks?: number | null;
    };

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export default function ChatPage() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", content: "AI: 相談内容をどうぞ。" },
  ]);
  const [loading, setLoading] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);

  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  useEffect(() => {
    // セッションの準備（ログイン済み前提の画面）
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "AI: ログインが必要です。" },
        ]);
        setSessionReady(false);
        return;
      }
      setSessionReady(true);
    })();
  }, []);

  async function handleSend() {
    const text = input.trim();
    if (!text || loading) return;

    setInput("");
    setLoading(true);
    setMessages((prev) => [...prev, { role: "user", content: text }]);

    try {
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;

      if (!accessToken) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "AI: セッションが切れています。再ログインしてください。" },
        ]);
        setLoading(false);
        return;
      }

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          message: text,
        }),
      });

      // ここで落ちても JSON を拾えるようにする
      let dataJson: ChatRes | null = null;
      try {
        dataJson = (await res.json()) as ChatRes;
      } catch {
        dataJson = null;
      }

      let msg: string;

      if (!dataJson) {
        msg = "AI: 返答の解析に失敗しました（JSONではない応答）。";
      } else if (!dataJson.ok) {
        // ✅ ここが今回のビルドエラーの原因：data.error を union 型のエラー側で扱う
        msg =
          dataJson.error === "quota exceeded"
            ? `AI: 回数上限です (${dataJson.used_talks ?? "?"}/${dataJson.limit_talks ?? "?"})`
            : `AI: ${dataJson.error}`;
      } else {
        msg = dataJson.message;
      }

      setMessages((prev) => [...prev, { role: "assistant", content: msg }]);
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `AI: 通信エラー (${e?.message ?? "unknown"})` },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: 16 }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 12 }}>税務顧問bot｜チャット</h1>

      {!sessionReady && (
        <div
          style={{
            padding: 12,
            border: "1px solid #ddd",
            borderRadius: 8,
            marginBottom: 12,
          }}
        >
          ログイン状態を確認中…（ログインしてないと動かんで）
        </div>
      )}

      <div
        style={{
          border: "1px solid #ddd",
          borderRadius: 12,
          padding: 12,
          height: "60vh",
          overflowY: "auto",
          background: "#fff",
        }}
      >
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              margin: "10px 0",
              display: "flex",
              justifyContent: m.role === "user" ? "flex-end" : "flex-start",
            }}
          >
            <div
              style={{
                maxWidth: "80%",
                padding: "10px 12px",
                borderRadius: 12,
                border: "1px solid #eee",
                background: m.role === "user" ? "#f3f4f6" : "#fafafa",
                whiteSpace: "pre-wrap",
                lineHeight: 1.5,
              }}
            >
              {m.content}
            </div>
          </div>
        ))}

        {loading && (
          <div style={{ margin: "10px 0", color: "#666" }}>AI: うーん…（考え中）</div>
        )}
        <div ref={bottomRef} />
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="相談内容を入力（Enterで送信）"
          style={{
            flex: 1,
            padding: "10px 12px",
            borderRadius: 10,
            border: "1px solid #ddd",
          }}
          disabled={!sessionReady || loading}
        />
        <button
          onClick={handleSend}
          disabled={!sessionReady || loading || !input.trim()}
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            border: "1px solid #ddd",
            background: !sessionReady || loading || !input.trim() ? "#f3f4f6" : "#fff",
            cursor: !sessionReady || loading || !input.trim() ? "not-allowed" : "pointer",
            fontWeight: 700,
          }}
        >
          送信
        </button>
      </div>

      <div style={{ marginTop: 10, fontSize: 12, color: "#666" }}>
        ※ “quota exceeded / no active plan” が出る場合は、API側の users 取得（RLS/ServiceRole）問題が本丸。
      </div>
    </div>
  );
}
