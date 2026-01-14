"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";

type ChatMessage = { role: "user" | "assistant"; content: string };

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

type StatusRes =
  | { ok: true; plan: string; used_talks: number | null; limit_talks: number | null }
  | { ok: false; error: string };

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const PLAN_LABEL: Record<string, string> = {
  lite: "Lite",
  standard: "Standard",
  enterprise: "Enterprise",
};

export default function ChatPage() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", content: "AI: 相談内容をどうぞ。" },
  ]);

  const [loading, setLoading] = useState(false);

  // ✅ ここがポイント：チェック完了/未ログイン/ログイン済を分ける
  const [sessionChecked, setSessionChecked] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);

  // status
  const [plan, setPlan] = useState<string>("free");
  const [used, setUsed] = useState<number>(0);
  const [limit, setLimit] = useState<number>(0);

  // checkout
  const [checkoutLoading, setCheckoutLoading] = useState(false);

  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const remaining = Math.max(0, (limit ?? 0) - (used ?? 0));
  const hasActivePlan = plan !== "free" && (limit ?? 0) > 0;
  const lowRemaining = hasActivePlan && remaining <= 3 && remaining > 0;
  const zeroRemaining = hasActivePlan && remaining === 0;

  function statusTheme() {
    if (!hasActivePlan) return { border: "#ddd", text: "#333", badge: "未契約" };
    if (zeroRemaining) return { border: "#dc2626", text: "#991b1b", badge: "上限到達" };
    if (lowRemaining) return { border: "#f59e0b", text: "#92400e", badge: "残りわずか" };
    return { border: "#16a34a", text: "#166534", badge: "利用可能" };
  }

  const theme = statusTheme();

  async function getAccessToken(): Promise<string | null> {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }

  async function fetchStatus() {
    const accessToken = await getAccessToken();
    if (!accessToken) return;

    const res = await fetch("/api/chat/status", {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });

    let json: StatusRes | null = null;
    try {
      json = (await res.json()) as StatusRes;
    } catch {
      json = null;
    }

    if (json && json.ok) {
      setPlan(json.plan);
      setUsed(json.used_talks ?? 0);
      setLimit(json.limit_talks ?? 0);
    }
  }

  async function startCheckout(nextPlan: "lite" | "standard" | "enterprise") {
    if (checkoutLoading) return;

    setCheckoutLoading(true);

    try {
      const accessToken = await getAccessToken();
      if (!accessToken) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "AI: セッション切れ。再ログインしてな。" },
        ]);
        return;
      }

      const res = await fetch("/api/create-checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ plan: nextPlan }),
      });

      const raw = await res.text();

      let json: any = null;
      try {
        json = JSON.parse(raw);
      } catch {
        json = null;
      }

      const url =
        (json && (json.url || json.checkoutUrl || json.checkout_url)) ||
        (typeof json === "string" ? json : null);

      if (!res.ok) {
        const errMsg = json?.error || `create-checkout failed (status=${res.status})`;
        setMessages((prev) => [...prev, { role: "assistant", content: `AI: 決済に進めません（${errMsg}）` }]);
        return;
      }

      if (url && typeof url === "string") {
        window.location.href = url;
        return;
      }

      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "AI: 決済URLが取得できませんでした（レスポンス形式不一致）。" },
      ]);
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `AI: 決済通信エラー（${e?.message ?? "unknown"}）` },
      ]);
    } finally {
      setCheckoutLoading(false);
    }
  }

  // ✅ 起動時：セッション確認 → sessionChecked を必ず true にする
  useEffect(() => {
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (!data.session) {
          setSessionReady(false);
          setMessages((prev) => [...prev, { role: "assistant", content: "AI: ログインが必要です。" }]);
          return;
        }
        setSessionReady(true);
        await fetchStatus();
      } finally {
        setSessionChecked(true);
      }
    })();
  }, []);

  async function handleSend() {
    const text = input.trim();
    if (!text || loading) return;

    if (!sessionReady) {
      setMessages((prev) => [...prev, { role: "assistant", content: "AI: ログインが必要です。" }]);
      return;
    }

    if (zeroRemaining) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "AI: 今月の上限に到達しています。上のボタンからプラン更新できます。" },
      ]);
      return;
    }

    if (!hasActivePlan) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "AI: プラン未契約です。上のボタンから決済に進んでください。" },
      ]);
      return;
    }

    setInput("");
    setLoading(true);
    setMessages((prev) => [...prev, { role: "user", content: text }]);

    try {
      const accessToken = await getAccessToken();
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
        body: JSON.stringify({ message: text }),
      });

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
        msg =
          dataJson.error === "quota exceeded"
            ? `AI: 回数上限です (${dataJson.used_talks ?? "?"}/${dataJson.limit_talks ?? "?"})`
            : `AI: ${dataJson.error}`;
      } else {
        msg = dataJson.message;
      }

      setMessages((prev) => [...prev, { role: "assistant", content: msg }]);
      await fetchStatus();
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `AI: 通信エラー (${e?.message ?? "unknown"})` },
      ]);
    } finally {
      setLoading(false);
    }
  }

  const badgeText = !hasActivePlan
    ? "プラン: free（未契約）"
    : `プラン: ${plan} / 残り ${remaining} 回（${used}/${limit}）`;

  const hintText = !sessionChecked
    ? "ログイン状態を確認中…"
    : !sessionReady
      ? "ログインが必要です（別ドメイン/別環境だと未ログイン扱いになります）"
      : !hasActivePlan
        ? "この画面で相談するにはプラン契約が必要です。"
        : zeroRemaining
          ? "今月の上限に到達。プラン更新（または上位プラン）で即回復できます。"
          : lowRemaining
            ? `残りわずか（あと ${remaining} 回）。必要なら早めにプラン調整を。`
            : "利用可能です。";

  const canSend =
    sessionReady && sessionChecked && !loading && !!input.trim() && hasActivePlan && !zeroRemaining;

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: 16 }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 10 }}>税務顧問bot｜チャット</h1>

      <div
        style={{
          padding: "10px 12px",
          border: `1px solid ${theme.border}`,
          borderRadius: 12,
          marginBottom: 12,
          fontSize: 13,
          color: theme.text,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 800 }}>{badgeText}</span>
            <span
              style={{
                fontSize: 12,
                padding: "2px 8px",
                borderRadius: 999,
                border: `1px solid ${theme.border}`,
                color: theme.text,
              }}
            >
              {theme.badge}
            </span>
          </div>

          <div style={{ fontSize: 12, color: "#666" }}>{hintText}</div>

          {sessionChecked && sessionReady && (!hasActivePlan || zeroRemaining) && (
            <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button
                onClick={() => startCheckout("lite")}
                disabled={checkoutLoading}
                style={{
                  padding: "8px 10px",
                  borderRadius: 10,
                  border: "1px solid #ddd",
                  background: "#fff",
                  cursor: checkoutLoading ? "not-allowed" : "pointer",
                  fontWeight: 800,
                }}
              >
                {PLAN_LABEL.lite}で開始
              </button>

              <button
                onClick={() => startCheckout("standard")}
                disabled={checkoutLoading}
                style={{
                  padding: "8px 10px",
                  borderRadius: 10,
                  border: "1px solid #ddd",
                  background: "#fff",
                  cursor: checkoutLoading ? "not-allowed" : "pointer",
                  fontWeight: 800,
                }}
              >
                {PLAN_LABEL.standard}で開始
              </button>

              <button
                onClick={() => startCheckout("enterprise")}
                disabled={checkoutLoading}
                style={{
                  padding: "8px 10px",
                  borderRadius: 10,
                  border: "1px solid #ddd",
                  background: "#fff",
                  cursor: checkoutLoading ? "not-allowed" : "pointer",
                  fontWeight: 800,
                }}
              >
                {PLAN_LABEL.enterprise}へ
              </button>

              {checkoutLoading && <span style={{ fontSize: 12, color: "#666" }}>決済ページを準備中…</span>}
            </div>
          )}
        </div>

        <button
          onClick={() => fetchStatus()}
          disabled={!sessionReady || loading}
          style={{
            padding: "8px 10px",
            borderRadius: 10,
            border: "1px solid #ddd",
            background: !sessionReady || loading ? "#f3f4f6" : "#fff",
            cursor: !sessionReady || loading ? "not-allowed" : "pointer",
            fontWeight: 800,
            whiteSpace: "nowrap",
          }}
        >
          更新
        </button>
      </div>

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
          style={{
            flex: 1,
            padding: "10px 12px",
            borderRadius: 10,
            border: "1px solid #ddd",
          }}
          disabled={!sessionChecked || !sessionReady || loading || !hasActivePlan || zeroRemaining}
        />
        <button
          onClick={handleSend}
          disabled={!canSend}
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            border: "1px solid #ddd",
            background: !canSend ? "#f3f4f6" : "#fff",
            cursor: !canSend ? "not-allowed" : "pointer",
            fontWeight: 800,
            whiteSpace: "nowrap",
          }}
        >
          送信
        </button>
      </div>

      <div style={{ marginTop: 10, fontSize: 12, color: "#666" }}>
        ※ 決済後に別ドメインに戻ると未ログイン扱いになります。APP_URL固定で回避済み。
      </div>
    </div>
  );
}
