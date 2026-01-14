"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getSupabaseClient } from "../lib/supabaseClient";

type ChatMessage = { role: "user" | "assistant"; content: string };

type ChatRes =
  | { ok: true; plan: string; used_talks: number | null; limit_talks: number | null; message: string }
  | { ok: false; error: string; used_talks?: number | null; limit_talks?: number | null };

type StatusRes =
  | { ok: true; plan: string; used_talks: number | null; limit_talks: number | null }
  | { ok: false; error: string };

type CheckoutRes = { ok: true; url: string } | { ok: false; error: string };

const PLAN_LABEL: Record<string, string> = {
  free: "free（未契約）",
  lite: "lite",
  standard: "standard",
  enterprise: "enterprise",
};

export default function ChatPage() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([{ role: "assistant", content: "AI: 相談内容をどうぞ。" }]);
  const [loading, setLoading] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);

  // status
  const [plan, setPlan] = useState<string>("free");
  const [used, setUsed] = useState<number>(0);
  const [limit, setLimit] = useState<number>(0);

  // checkout
  const [checkoutLoading, setCheckoutLoading] = useState(false);

  const bottomRef = useRef<HTMLDivElement | null>(null);

  const supabase = useMemo(() => {
    try {
      return getSupabaseClient();
    } catch (e: any) {
      // env不足はここで止める
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content:
            "AI: 環境変数が足りません（Vercelで NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を入れてRedeployしてください）。",
        },
      ]);
      return null;
    }
  }, []);

  const scrollBottom = () => bottomRef.current?.scrollIntoView({ behavior: "smooth" });

  const refreshStatus = async () => {
    if (!supabase) return;

    try {
      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session?.access_token) {
        setSessionReady(false);
        setPlan("free");
        setUsed(0);
        setLimit(0);
        return;
      }
      setSessionReady(true);

      const res = await fetch("/api/chat/status", {
        headers: { Authorization: `Bearer ${data.session.access_token}` },
      });
      const json = (await res.json().catch(() => null)) as StatusRes | null;

      if (!json || !json.ok) {
        setPlan("free");
        setUsed(0);
        setLimit(0);
        return;
      }

      setPlan(json.plan ?? "free");
      setUsed(Number(json.used_talks ?? 0));
      setLimit(Number(json.limit_talks ?? 0));
    } catch {
      // 何もしない（表示崩し防止）
    }
  };

  useEffect(() => {
    refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    scrollBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, loading]);

  const startCheckout = async (targetPlan: "lite" | "standard" | "enterprise") => {
    if (!supabase) return;

    setCheckoutLoading(true);
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session?.access_token) {
        window.location.href = "/login";
        return;
      }

      const res = await fetch("/api/create-checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${data.session.access_token}`,
        },
        body: JSON.stringify({ plan: targetPlan }),
      });

      const json = (await res.json().catch(() => null)) as CheckoutRes | null;

      if (!json) throw new Error("create-checkout: empty response");
      if (!json.ok) throw new Error(json.error || "create-checkout failed");
      if (!json.url) throw new Error("create-checkout: url missing");

      window.location.href = json.url;
    } catch (e: any) {
      setMessages((prev) => [...prev, { role: "assistant", content: `AI: 決済に進めません（${e?.message ?? String(e)}）` }]);
    } finally {
      setCheckoutLoading(false);
    }
  };

  const handleSend = async () => {
    if (!supabase) return;
    const text = input.trim();
    if (!text || loading) return;

    setInput("");
    setLoading(true);

    setMessages((prev) => [...prev, { role: "user", content: text }]);

    try {
      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session?.access_token) {
        setMessages((prev) => [...prev, { role: "assistant", content: "AI: ログインが必要です。" }]);
        setLoading(false);
        return;
      }

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${data.session.access_token}`,
        },
        body: JSON.stringify({ message: text }),
      });

      const json = (await res.json().catch(() => null)) as ChatRes | null;

      if (!json) {
        setMessages((prev) => [...prev, { role: "assistant", content: "AI: 返答の取得に失敗しました（空レスポンス）" }]);
        return;
      }

      if (!json.ok) {
        // quota超え or no active plan の想定
        const err = json.error || "error";
        setMessages((prev) => [...prev, { role: "assistant", content: `AI: ${err}` }]);

        // status再取得（表示更新）
        await refreshStatus();
        return;
      }

      // 回数表示も更新
      setPlan(json.plan ?? plan);
      setUsed(Number(json.used_talks ?? used));
      setLimit(Number(json.limit_talks ?? limit));

      setMessages((prev) => [...prev, { role: "assistant", content: `AI: ${json.message}` }]);
    } catch (e: any) {
      setMessages((prev) => [...prev, { role: "assistant", content: `AI: 通信エラー（${e?.message ?? String(e)}）` }]);
    } finally {
      setLoading(false);
      await refreshStatus();
    }
  };

  const remaining = Math.max(0, (limit || 0) - (used || 0));
  const low = limit > 0 && remaining <= 2;
  const zero = limit > 0 && remaining <= 0;

  return (
    <main style={{ maxWidth: 900, margin: "28px auto", padding: 16 }}>
      <h1 style={{ textAlign: "center", marginBottom: 14 }}>税務顧問bot｜チャット</h1>

      <div
        style={{
          border: `2px solid ${zero ? "#f55" : low ? "#f7a400" : "#ddd"}`,
          background: zero ? "#fff5f5" : low ? "#fff7e6" : "#fafafa",
          borderRadius: 14,
          padding: 12,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div style={{ fontWeight: 800 }}>
          プラン: {PLAN_LABEL[plan] ?? plan} / 残り {remaining} 回（{used}/{limit || 0}）
          {low && !zero && <span style={{ marginLeft: 10, fontWeight: 900 }}>残りわずか</span>}
          {zero && <span style={{ marginLeft: 10, fontWeight: 900 }}>上限到達</span>}
        </div>

        <button
          onClick={refreshStatus}
          style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}
        >
          更新
        </button>
      </div>

      {zero && (
        <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            onClick={() => startCheckout("lite")}
            disabled={checkoutLoading}
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid #ddd",
              background: "#fff",
              cursor: checkoutLoading ? "not-allowed" : "pointer",
              fontWeight: 800,
            }}
          >
            Liteで開始
          </button>
          <button
            onClick={() => startCheckout("standard")}
            disabled={checkoutLoading}
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid #ddd",
              background: "#fff",
              cursor: checkoutLoading ? "not-allowed" : "pointer",
              fontWeight: 800,
            }}
          >
            Standardで開始
          </button>
          <button
            onClick={() => startCheckout("enterprise")}
            disabled={checkoutLoading}
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid #ddd",
              background: "#fff",
              cursor: checkoutLoading ? "not-allowed" : "pointer",
              fontWeight: 800,
            }}
          >
            Enterpriseへ
          </button>
          {checkoutLoading && <div style={{ alignSelf: "center", color: "#666" }}>決済ページへ移動中…</div>}
        </div>
      )}

      <div
        style={{
          marginTop: 14,
          border: "1px solid #ddd",
          borderRadius: 14,
          padding: 12,
          minHeight: 420,
          background: "#fff",
        }}
      >
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              justifyContent: m.role === "user" ? "flex-end" : "flex-start",
              margin: "10px 0",
            }}
          >
            <div
              style={{
                maxWidth: "80%",
                padding: "10px 12px",
                borderRadius: 12,
                background: m.role === "user" ? "#f1f5ff" : "#f6f6f6",
                border: "1px solid #eee",
                whiteSpace: "pre-wrap",
              }}
            >
              {m.role === "user" ? `あなた: ${m.content}` : m.content}
            </div>
          </div>
        ))}

        {loading && <div style={{ margin: "10px 0", color: "#666" }}>AI: うーん…（考え中）</div>}
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
          style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: "1px solid #ddd" }}
          disabled={!sessionReady || loading || zero}
        />
        <button
          onClick={handleSend}
          disabled={!sessionReady || loading || !input.trim() || zero}
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            border: "1px solid #ddd",
            background: !sessionReady || loading || !input.trim() || zero ? "#f3f4f6" : "#fff",
            cursor: !sessionReady || loading || !input.trim() || zero ? "not-allowed" : "pointer",
            fontWeight: 800,
          }}
        >
          送信
        </button>
      </div>

      <p style={{ color: "#666", fontSize: 12, marginTop: 10 }}>
        ※ 未契約/上限到達のときは送信不可（無駄打ち防止）。決済ボタンから Stripe Checkout に直行します。
      </p>
    </main>
  );
}
