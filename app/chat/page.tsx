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

// ✅ ここを将来 Stripe の価格ページ/アップグレード導線に変える
const UPGRADE_URL = "/"; // いったんトップ。あとで /pricing や /create-checkout に差し替え

export default function ChatPage() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([{ role: "assistant", content: "AI: 相談内容をどうぞ。" }]);
  const [loading, setLoading] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);

  // status
  const [plan, setPlan] = useState<string>("free");
  const [used, setUsed] = useState<number>(0);
  const [limit, setLimit] = useState<number>(0);

  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const remaining = Math.max(0, (limit ?? 0) - (used ?? 0));
  const hasActivePlan = plan !== "free" && limit > 0;
  const lowRemaining = hasActivePlan && remaining <= 3 && remaining > 0;
  const zeroRemaining = hasActivePlan && remaining === 0;

  function statusTheme() {
    // 背景色は指定せず、ボーダーと文字で雰囲気を出す（指定色は最小限）
    if (!hasActivePlan) {
      return { border: "#ddd", text: "#333", badge: "未契約" };
    }
    if (zeroRemaining) {
      return { border: "#dc2626", text: "#991b1b", badge: "上限到達" };
    }
    if (lowRemaining) {
      return { border: "#f59e0b", text: "#92400e", badge: "残りわずか" };
    }
    return { border: "#16a34a", text: "#166534", badge: "利用可能" };
  }

  const theme = statusTheme();

  async function fetchStatus() {
    const { data } = await supabase.auth.getSession();
    const accessToken = data.session?.access_token;
    if (!accessToken) return;

    const res = await fetch("/api/chat/status", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
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

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        setMessages((prev) => [...prev, { role: "assistant", content: "AI: ログインが必要です。" }]);
        setSessionReady(false);
        return;
      }
      setSessionReady(true);
      await fetchStatus();
    })();
  }, []);

  async function handleSend() {
    const text = input.trim();
    if (!text || loading) return;

    // ✅ 上限到達なら送らせない（UX改善）
    if (zeroRemaining) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "AI: 今月の上限に到達しています。プラン更新で即回復できます。",
        },
      ]);
      return;
    }

    setInput("");
    setLoading(true);
    setMessages((prev) => [...prev, { role: "user", content: text }]);

    try {
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;

      if (!accessToken) {
        setMessages((prev) => [...prev, { role: "assistant", content: "AI: セッションが切れています。再ログインしてください。" }]);
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

      // ✅ 送信後に残数を更新
      await fetchStatus();

      // ✅ 残りわずかになったら自動で一言（営業はウザくない程度に）
      // （状態は fetchStatus の結果反映後になるので、ざっくり予告だけ）
      // ここは好みで削ってOK
    } catch (e: any) {
      setMessages((prev) => [...prev, { role: "assistant", content: `AI: 通信エラー (${e?.message ?? "unknown"})` }]);
    } finally {
      setLoading(false);
    }
  }

  const badgeText = !hasActivePlan
    ? "プラン: free（未契約）"
    : `プラン: ${plan} / 残り ${remaining} 回（${used}/${limit}）`;

  const hintText = !hasActivePlan
    ? "この画面で相談するにはプラン契約が必要です。"
    : zeroRemaining
      ? "今月の上限に到達。プラン更新で即回復できます。"
      : lowRemaining
        ? `残りわずか（あと ${remaining} 回）。必要なら早めにプラン調整を。`
        : "利用可能です。";

  const canSend = sessionReady && !loading && !!input.trim() && (!hasActivePlan ? false : !zeroRemaining);

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: 16 }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 10 }}>税務顧問bot｜チャット</h1>

      {/* ✅ ステータスバー（警告UI付き） */}
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
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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

          {/* ✅ 0回のときだけ導線を出す */}
          {zeroRemaining && (
            <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center" }}>
              <a
                href={UPGRADE_URL}
                style={{
                  display: "inline-block",
                  padding: "8px 10px",
                  borderRadius: 10,
                  border: `1px solid ${theme.border}`,
                  textDecoration: "none",
                  fontWeight: 800,
                  color: theme.text,
                }}
              >
                プラン更新へ
              </a>
              <span style={{ fontSize: 12, color: "#666" }}>（更新したらすぐ使えるようにする）</span>
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

      {!sessionReady && (
        <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8, marginBottom: 12 }}>
          ログイン状態を確認中…
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
          disabled={!sessionReady || loading || (!hasActivePlan ? true : zeroRemaining)}
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
        ※ 残り0回の場合は送信できません（無駄打ち防止）。プラン更新で即復帰する導線にします。
      </div>
    </div>
  );
}
