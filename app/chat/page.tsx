"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { getSupabaseClient } from "../lib/supabaseClient";

type ChatMessage = { role: "user" | "assistant"; content: string; created_at?: string };
type ConversationRow = {
  id: string;
  summary: string | null;
  created_at: string;
  summary_updated_at: string | null;
};

type ChatRes =
  | {
      ok: true;
      plan: string;
      used_talks: number | null;
      limit_talks: number | null;
      conversation_id: string | null;
      message: string;
    }
  | { ok: false; error: string; used_talks?: number | null; limit_talks?: number | null };

type StatusRes =
  | { ok: true; plan: string; used_talks: number | null; limit_talks: number | null }
  | { ok: false; error: string };

type Dialect = "kansai" | "standard";
type Stance = "zubatto" | "sanbo";

const BOT = "さじかげん";

const PLAN_LABEL: Record<string, string> = {
  free: "free（未契約）",
  lite: "lite",
  standard: "standard",
  enterprise: "enterprise",
};

const CONTACT_URL = "https://forms.gle/REPLACE_WITH_YOUR_FORM"; // ←GoogleフォームURLに差し替え推奨
// const CONTACT_MAILTO = "mailto:support@example.com?subject=%E3%81%95%E3%81%98%E3%81%8B%E3%81%92%E3%82%93%20%E3%81%8A%E5%95%8F%E3%81%84%E5%90%88%E3%82%8F%E3%81%9B";

function nowTime() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// UUID v4
function uuidv4(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function formatMmddHm(iso: string) {
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mi}`;
}

export default function ChatPage() {
  const [input, setInput] = useState("");

  // ✅ activeConversationId方式
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", content: `${BOT}: 相談内容をどうぞ。` },
  ]);

  const [loading, setLoading] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);

  // 送信中に同じ冪等キーを保持（再送・リトライで二重カウント防止）
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  // status
  const [plan, setPlan] = useState<string>("free");
  const [used, setUsed] = useState<number>(0);
  const [limit, setLimit] = useState<number>(0);

  // status UI feedback
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string>("");

  // mode toggles（送信しない限りトーク消費ゼロ）
  const [dialect, setDialect] = useState<Dialect>("kansai");
  const [stance, setStance] = useState<Stance>("zubatto");

  // rename
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameText, setRenameText] = useState("");

  // UI refs
  const listRef = useRef<HTMLDivElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const statusMsgTimer = useRef<number | null>(null);

  const supabase = useMemo(() => {
    try {
      return getSupabaseClient();
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `${BOT}: 環境変数が足りません（Vercelで NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を入れてRedeployしてください）。`,
        },
      ]);
      return null;
    }
  }, []);

  const showStatusMsg = (msg: string) => {
    setStatusMsg(msg);
    if (statusMsgTimer.current) window.clearTimeout(statusMsgTimer.current);
    statusMsgTimer.current = window.setTimeout(() => {
      setStatusMsg("");
      statusMsgTimer.current = null;
    }, 2500);
  };

  const refreshStatus = async (opts?: { silent?: boolean }) => {
    if (!supabase) return;

    if (!opts?.silent) setStatusLoading(true);
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session?.access_token) {
        setSessionReady(false);
        setPlan("free");
        setUsed(0);
        setLimit(0);
        if (!opts?.silent) showStatusMsg("未ログイン（free）に戻しました");
        return;
      }
      setSessionReady(true);

      const res = await fetch(`/api/chat/status?ts=${Date.now()}`, {
        headers: { Authorization: `Bearer ${data.session.access_token}` },
        cache: "no-store",
      });

      if (!res.ok) {
        setPlan("free");
        setUsed(0);
        setLimit(0);
        if (!opts?.silent) showStatusMsg(`更新失敗（HTTP ${res.status}）`);
        return;
      }

      const json = (await res.json().catch(() => null)) as StatusRes | null;

      if (!json || !json.ok) {
        setPlan("free");
        setUsed(0);
        setLimit(0);
        if (!opts?.silent) showStatusMsg(`更新失敗（${json?.error ?? "invalid response"}）`);
        return;
      }

      const nextPlan = json.plan ?? "free";
      const nextUsed = Number(json.used_talks ?? 0);
      const nextLimit = Number(json.limit_talks ?? 0);

      setPlan(nextPlan);
      setUsed(nextUsed);
      setLimit(nextLimit);

      if (!opts?.silent) showStatusMsg(`更新しました（${nowTime()}）`);
    } catch (e: any) {
      if (!opts?.silent) showStatusMsg(`更新失敗（${e?.message ?? String(e)}）`);
    } finally {
      if (!opts?.silent) setStatusLoading(false);
    }
  };

  // ✅ スレッド一覧
  const loadConversations = async () => {
    if (!supabase) return;

    const { data: sess } = await supabase.auth.getSession();
    if (!sess.session?.access_token) {
      setConversations([]);
      setActiveConversationId(null);
      setMessages([{ role: "assistant", content: `${BOT}: 相談内容をどうぞ。` }]);
      return;
    }

    const { data, error } = await supabase
      .from("conversations")
      .select("id,summary,created_at,summary_updated_at")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) return;

    const rows = (data ?? []) as ConversationRow[];
    setConversations(rows);

    // 初回：一番上を開く（ただし、今が新規状態なら触らない）
    if (!activeConversationId && rows.length > 0) {
      // ここは「新規で始めたい」より「前回の続き」を優先
      setActiveConversationId(rows[0].id);
    }
  };

  // ✅ activeConversationId のメッセージ読込
  const loadMessages = async (conversationId: string) => {
    if (!supabase) return;

    const { data: sess } = await supabase.auth.getSession();
    if (!sess.session?.access_token) return;

    const { data, error } = await supabase
      .from("messages")
      .select("role,content,created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(300);

    if (error) return;

    const rows = (data ?? []) as any[];
    const msgs: ChatMessage[] = rows.map((r) => ({
      role: r.role,
      content: r.content,
      created_at: r.created_at,
    }));

    // 先頭に案内メッセが無い場合だけ足す（古い会話向け）
    if (msgs.length === 0) {
      setMessages([{ role: "assistant", content: `${BOT}: 相談内容をどうぞ。` }]);
    } else {
      setMessages(msgs);
    }
  };

  // ✅ 右ペイン：最下部へ（スクロールは「右の枠内だけ」）
  const scrollChatBottom = () => {
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  };

  useEffect(() => {
    refreshStatus({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 初回と、ログイン状態変化っぽいタイミングでスレッド再読込
  useEffect(() => {
    loadConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionReady]);

  // activeConversationId が変わったらメッセージ読込
  useEffect(() => {
    if (!activeConversationId) return;
    loadMessages(activeConversationId);
    setRenameOpen(false);
    setRenameText("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId]);

  // メッセージ追加時に右だけ最下部へ
  useEffect(() => {
    scrollChatBottom();
  }, [messages, loading]);

  const startNewThread = () => {
    setActiveConversationId(null);
    setRenameOpen(false);
    setRenameText("");
    setMessages([{ role: "assistant", content: `${BOT}: 相談内容をどうぞ。` }]);
  };

  const openRename = () => {
    const cur = conversations.find((c) => c.id === activeConversationId);
    setRenameText(cur?.summary ?? "");
    setRenameOpen(true);
  };

  const saveRename = async () => {
    if (!supabase) return;
    if (!activeConversationId) return;

    const name = renameText.trim();
    if (!name) {
      setRenameOpen(false);
      return;
    }

    const { error } = await supabase
      .from("conversations")
      .update({ summary: name, summary_updated_at: new Date().toISOString() })
      .eq("id", activeConversationId);

    if (!error) {
      await loadConversations();
      setRenameOpen(false);
    }
  };

  const handleSend = async () => {
    if (!supabase) return;
    const text = input.trim();
    if (!text || loading) return;

    // 送信中は同じキー、次送信は新規キー
    const idempotencyKey = pendingKey ?? uuidv4();
    setPendingKey(idempotencyKey);

    setInput("");
    setLoading(true);

    // 表示は先に追加
    setMessages((prev) => [...prev, { role: "user", content: text }]);

    try {
      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session?.access_token) {
        setMessages((prev) => [...prev, { role: "assistant", content: `${BOT}: ログインが必要です。` }]);
        setLoading(false);
        return;
      }

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${data.session.access_token}`,
        },
        body: JSON.stringify({
          message: text,
          idempotencyKey,
          conversationId: activeConversationId, // ✅ activeConversationId
          dialect,
          stance,
        }),
      });

      const json = (await res.json().catch(() => null)) as ChatRes | null;

      if (!json) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `${BOT}: 返答の取得に失敗しました（空レスポンス）` },
        ]);
        return;
      }

      if (!json.ok) {
        const err = json.error || "error";
        setMessages((prev) => [...prev, { role: "assistant", content: `${BOT}: ${err}` }]);
        await refreshStatus({ silent: true });
        return;
      }

      setPlan(json.plan ?? plan);
      setUsed(Number(json.used_talks ?? used));
      setLimit(Number(json.limit_talks ?? limit));

      // ✅ 新規スレッドだった場合：返ってきた conversation_id を採用
      if (!activeConversationId && json.conversation_id) {
        setActiveConversationId(json.conversation_id);
        // 一覧を更新（summary seed が反映される）
        await loadConversations();
      }

      setMessages((prev) => [...prev, { role: "assistant", content: `${BOT}: ${json.message}` }]);
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `${BOT}: 通信エラー（${e?.message ?? String(e)}）` },
      ]);
    } finally {
      setLoading(false);
      setPendingKey(null);
      await refreshStatus({ silent: true });
    }
  };

  const remaining = Math.max(0, (limit || 0) - (used || 0));
  const low = limit > 0 && remaining <= 2;
  const zero = limit > 0 && remaining <= 0;

  const activeConv = conversations.find((c) => c.id === activeConversationId);
  const title = activeConversationId ? activeConv?.summary || "（無題）" : "（新規）";

  const ModeButton = (props: {
    active: boolean;
    label: string;
    onClick: () => void;
  }) => (
    <button
      onClick={props.onClick}
      style={{
        padding: "6px 10px",
        borderRadius: 10,
        border: "1px solid #ddd",
        background: props.active ? "#111" : "#fff",
        color: props.active ? "#fff" : "#111",
        cursor: "pointer",
        fontWeight: 800,
      }}
    >
      {props.label}
    </button>
  );

  return (
    <main style={{ maxWidth: 1080, margin: "24px auto", padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <h1 style={{ textAlign: "center", margin: "0 auto 10px", fontWeight: 900 }}>
          さじかげん｜税務相談
        </h1>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Link
            href="/settings/billing"
            style={{
              textDecoration: "none",
              padding: "8px 12px",
              borderRadius: 10,
              border: "1px solid #ddd",
              background: "#fff",
              fontWeight: 800,
              color: "#111",
              whiteSpace: "nowrap",
            }}
          >
            プラン変更
          </Link>

          <a
            href={CONTACT_URL}
            target="_blank"
            rel="noreferrer"
            style={{
              textDecoration: "none",
              padding: "8px 12px",
              borderRadius: 10,
              border: "1px solid #ddd",
              background: "#fff",
              fontWeight: 800,
              color: "#111",
              whiteSpace: "nowrap",
            }}
          >
            お問い合わせ
          </a>
        </div>
      </div>

      {/* status bar */}
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
          {statusMsg && <span style={{ marginLeft: 12, fontWeight: 700, color: "#666" }}>・{statusMsg}</span>}
        </div>

        <button
          onClick={() => refreshStatus()}
          disabled={statusLoading}
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            border: "1px solid #ddd",
            background: "#fff",
            cursor: statusLoading ? "not-allowed" : "pointer",
            fontWeight: 800,
          }}
        >
          {statusLoading ? "更新中…" : "更新"}
        </button>
      </div>

      {/* body */}
      <div
        style={{
          marginTop: 14,
          display: "grid",
          gridTemplateColumns: "280px 1fr",
          gap: 12,
          alignItems: "stretch",
        }}
      >
        {/* left: thread list */}
        <div
          style={{
            border: "1px solid #ddd",
            borderRadius: 14,
            background: "#fff",
            padding: 12,
            display: "flex",
            flexDirection: "column",
            minHeight: 520,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <div style={{ fontWeight: 900 }}>スレッド</div>
            <button
              onClick={startNewThread}
              style={{
                padding: "8px 10px",
                borderRadius: 10,
                border: "1px solid #ddd",
                background: "#fff",
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              新規
            </button>
          </div>

          <div
            ref={listRef}
            style={{
              marginTop: 10,
              overflowY: "auto",
              borderTop: "1px solid #eee",
              paddingTop: 10,
              flex: 1,
            }}
          >
            {conversations.length === 0 && (
              <div style={{ color: "#666", fontSize: 13, padding: "8px 4px" }}>
                スレッドがありません。<br />
                「新規」→送信で作成されます。
              </div>
            )}

            {conversations.map((c) => {
              const active = c.id === activeConversationId;
              const label = c.summary?.trim() ? c.summary.trim() : "（無題）";
              const timeLabel = c.summary_updated_at ? formatMmddHm(c.summary_updated_at) : formatMmddHm(c.created_at);

              return (
                <button
                  key={c.id}
                  onClick={() => setActiveConversationId(c.id)}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    border: "1px solid " + (active ? "#c7d2fe" : "#eee"),
                    background: active ? "#eef2ff" : "#fff",
                    borderRadius: 12,
                    padding: "10px 10px",
                    marginBottom: 10,
                    cursor: "pointer",
                  }}
                  title={label}
                >
                  <div style={{ fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {label}
                  </div>
                  <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>{timeLabel}</div>
                </button>
              );
            })}
          </div>
        </div>

        {/* right: chat */}
        <div
          style={{
            border: "1px solid #ddd",
            borderRadius: 14,
            background: "#fff",
            padding: 12,
            minHeight: 520,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* header row */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              paddingBottom: 10,
              borderBottom: "1px solid #eee",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
              <div style={{ fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {title}
              </div>

              {activeConversationId && (
                <>
                  <button
                    onClick={openRename}
                    style={{
                      padding: "6px 10px",
                      borderRadius: 10,
                      border: "1px solid #ddd",
                      background: "#fff",
                      fontWeight: 800,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    名前変更
                  </button>

                  {renameOpen && (
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input
                        value={renameText}
                        onChange={(e) => setRenameText(e.target.value)}
                        placeholder="スレッド名"
                        style={{
                          width: 220,
                          padding: "7px 10px",
                          borderRadius: 10,
                          border: "1px solid #ddd",
                        }}
                      />
                      <button
                        onClick={saveRename}
                        style={{
                          padding: "7px 10px",
                          borderRadius: 10,
                          border: "1px solid #ddd",
                          background: "#111",
                          color: "#fff",
                          fontWeight: 900,
                          cursor: "pointer",
                        }}
                      >
                        保存
                      </button>
                      <button
                        onClick={() => setRenameOpen(false)}
                        style={{
                          padding: "7px 10px",
                          borderRadius: 10,
                          border: "1px solid #ddd",
                          background: "#fff",
                          fontWeight: 800,
                          cursor: "pointer",
                        }}
                      >
                        取消
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {/* 口調 */}
              <ModeButton active={dialect === "kansai"} label="関西弁" onClick={() => setDialect("kansai")} />
              <ModeButton active={dialect === "standard"} label="標準語" onClick={() => setDialect("standard")} />

              {/* スタイル */}
              <ModeButton active={stance === "zubatto"} label="ズバっと" onClick={() => setStance("zubatto")} />
              <ModeButton active={stance === "sanbo"} label="参謀" onClick={() => setStance("sanbo")} />
            </div>
          </div>

          {/* messages area (scroll inside) */}
          <div
            ref={chatScrollRef}
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "12px 6px",
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
            {loading && <div style={{ margin: "10px 0", color: "#666" }}>{BOT}: （考え中）</div>}
          </div>

          {/* input row */}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
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
            ※ 未契約/上限到達のときは送信不可（無駄打ち防止）。口調/モード切替は送信しない限りトーク消費しません。
          </p>
        </div>
      </div>
    </main>
  );
}
