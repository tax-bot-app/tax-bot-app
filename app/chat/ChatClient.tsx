"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { getSupabaseClient } from "../lib/supabaseClient";

type Dialect = "kansai" | "standard";
type Stance = "zubatto" | "sanbo";

type ConversationRow = {
  id: string;
  summary: string | null;
  created_at: string;
  summary_updated_at: string | null;
};

type MessageRow = {
  id?: string;
  conversation_id: string;
  user_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

type StatusRes =
  | { ok: true; plan: string; used_talks: number | null; limit_talks: number | null }
  | { ok: false; error: string };

type ChatRes =
  | {
      ok: true;
      plan: string;
      used_talks: number | null;
      limit_talks: number | null;
      conversation_id: string | null;
      message: string;
    }
  | {
      ok: false;
      error: string;
      used_talks?: number | null;
      limit_talks?: number | null;
    };

type ThreadItem = {
  id: string;
  title: string;
  created_at: string;
  preview: string;
};

function fmtYmd(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

function fmtHm(iso: string): string {
  const d = new Date(iso);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function toJstLabel(iso: string): string {
  // 表示は端末ローカルTZでOK（日本想定）。必要ならUTC→JST固定にしてもええ。
  return fmtYmd(iso);
}

function short(s: string, n: number): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length <= n ? t : t.slice(0, n) + "…";
}

function getContactUrl(): string {
  // どっちでも運用できるように「環境変数があればそれ」「なければ mailto」
  // Vercel: NEXT_PUBLIC_CONTACT_URL = GoogleフォームURL など
  // 例) https://forms.gle/xxxxx
  return process.env.NEXT_PUBLIC_CONTACT_URL || "mailto:info@gladplan.com?subject=さじかげん%20お問い合わせ";
}

export default function ChatClient() {
  const supabase = useMemo(() => getSupabaseClient(), []);

  // ---- UI state ----
  const [plan, setPlan] = useState<string>("(loading)");
  const [usedTalks, setUsedTalks] = useState<number | null>(null);
  const [limitTalks, setLimitTalks] = useState<number | null>(null);

  const [dialect, setDialect] = useState<Dialect>("kansai");
  const [stance, setStance] = useState<Stance>("zubatto");

  const [threads, setThreads] = useState<ThreadItem[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [activeTitle, setActiveTitle] = useState<string>("(新規)");

  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const [errMsg, setErrMsg] = useState<string | null>(null);

  // ---- refs for scroll ----
  const msgScrollRef = useRef<HTMLDivElement | null>(null);

  // ---- helpers ----
  const scrollMessagesBottom = () => {
    const el = msgScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  };

  // localStorage: dialect/stance
  useEffect(() => {
    try {
      const d = (localStorage.getItem("chat_dialect") as Dialect | null) || null;
      const s = (localStorage.getItem("chat_stance") as Stance | null) || null;
      if (d === "kansai" || d === "standard") setDialect(d);
      if (s === "zubatto" || s === "sanbo") setStance(s);
    } catch {}
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("chat_dialect", dialect);
      localStorage.setItem("chat_stance", stance);
    } catch {}
  }, [dialect, stance]);

  async function fetchStatus() {
    setErrMsg(null);
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      setErrMsg(error.message);
      return;
    }
    const token = data.session?.access_token;
    if (!token) {
      setErrMsg("Not logged in");
      return;
    }

    const res = await fetch("/api/chat/status", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });

    const json = (await res.json().catch(() => null)) as StatusRes | null;
    if (!res.ok || !json || (json as any).ok === false) {
      setErrMsg((json as any)?.error || `status failed: ${res.status}`);
      return;
    }

    setPlan(json.plan);
    setUsedTalks(json.used_talks);
    setLimitTalks(json.limit_talks);
  }

  async function fetchThreads() {
    setErrMsg(null);

    const { data: s, error: sErr } = await supabase.auth.getSession();
    if (sErr) {
      setErrMsg(sErr.message);
      return;
    }
    const token = s.session?.access_token;
    if (!token) {
      setErrMsg("Not logged in");
      return;
    }

    // conversations: 直近30
    const { data: convs, error: convErr } = await supabase
      .from("conversations")
      .select("id, summary, created_at, summary_updated_at")
      .order("created_at", { ascending: false })
      .limit(30);

    if (convErr) {
      setErrMsg(convErr.message);
      return;
    }

    const base = (convs || []) as ConversationRow[];

    // preview（N+1だけど30件までなら許容。後でView/RPCにして最適化でOK）
    const items: ThreadItem[] = [];
    for (const c of base) {
      const { data: lastMsgs } = await supabase
        .from("messages")
        .select("content, role, created_at")
        .eq("conversation_id", c.id)
        .order("created_at", { ascending: false })
        .limit(1);

      const last = (lastMsgs?.[0] as any) || null;
      const preview = last?.content ? short(String(last.content), 20) : "";

      items.push({
        id: c.id,
        title: (c.summary && c.summary.trim()) || "(無題)",
        created_at: c.created_at,
        preview,
      });
    }

    setThreads(items);

    // active未選択なら先頭を選ぶ（ただし「新規状態」優先したいならここ消す）
    if (!activeConversationId && items.length > 0) {
      setActiveConversationId(items[0].id);
      setActiveTitle(items[0].title);
    }
  }

  async function fetchMessages(conversationId: string) {
    setErrMsg(null);

    const { data, error } = await supabase
      .from("messages")
      .select("id, conversation_id, user_id, role, content, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(200);

    if (error) {
      setErrMsg(error.message);
      return;
    }

    setMessages((data || []) as MessageRow[]);
    // 描画後に一番下へ
    setTimeout(scrollMessagesBottom, 0);
  }

  async function selectThread(id: string) {
    const t = threads.find((x) => x.id === id);
    setActiveConversationId(id);
    setActiveTitle(t?.title || "(無題)");
    setMessages([]);
    await fetchMessages(id);
  }

  function newThreadLocalOnly() {
    // ✅ “新規押下”ではDB作らない（最初の送信で route.ts が作る）
    setActiveConversationId(null);
    setActiveTitle("(新規)");
    setMessages([]);
    setErrMsg(null);
    // 入力欄にフォーカスしたいならここで focus
  }

  async function renameThread() {
    if (!activeConversationId) return;
    const current = activeTitle === "(無題)" ? "" : activeTitle;
    const name = prompt("スレッド名を入力（空ならキャンセル）", current);
    if (!name) return;

    const { error } = await supabase
      .from("conversations")
      .update({ summary: name, summary_updated_at: new Date().toISOString() })
      .eq("id", activeConversationId);

    if (error) {
      alert(`更新失敗: ${error.message}`);
      return;
    }

    setActiveTitle(name);
    await fetchThreads();
  }

  async function sendMessage() {
    const msg = input.trim();
    if (!msg) return;

    setLoading(true);
    setErrMsg(null);

    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;

      const token = data.session?.access_token;
      if (!token) throw new Error("Not logged in");

      const idempotencyKey =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`; // 念のため（本番はuuid推奨）

      // optimistic push（UI先出し）
      const tempConvId = activeConversationId || "pending";
      const nowIso = new Date().toISOString();

      const optimisticUser: MessageRow = {
        conversation_id: tempConvId,
        user_id: "me",
        role: "user",
        content: msg,
        created_at: nowIso,
      };

      setMessages((prev) => [...prev, optimisticUser]);
      setInput("");
      setTimeout(scrollMessagesBottom, 0);

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          message: msg,
          idempotencyKey,
          conversationId: activeConversationId, // nullなら route.ts が新規作成
          dialect,
          stance,
        }),
      });

      const json = (await res.json().catch(() => null)) as ChatRes | null;
      if (!json) throw new Error("Invalid response");

      if (!res.ok || json.ok === false) {
        throw new Error((json as any).error || `chat failed: ${res.status}`);
      }

      // usage更新
      setPlan(json.plan);
      setUsedTalks(json.used_talks);
      setLimitTalks(json.limit_talks);

      // 新規だった場合、ここで会話ID確定
      const convId = json.conversation_id || activeConversationId;

      // assistant reply追加
      const assistant: MessageRow = {
        conversation_id: convId || tempConvId,
        user_id: "bot",
        role: "assistant",
        content: json.message,
        created_at: new Date().toISOString(),
      };

      // pending置換（楽にいく：pendingでも表示は問題ないが、後で整える）
      setMessages((prev) => {
        const fixed = prev.map((m) => {
          if (m.conversation_id === "pending") return { ...m, conversation_id: convId || "pending" };
          return m;
        });
        return [...fixed, assistant];
      });

      // active確定＆一覧更新
      if (convId && convId !== activeConversationId) {
        setActiveConversationId(convId);
      }
      await fetchThreads();
      if (convId) await fetchMessages(convId);

      setTimeout(scrollMessagesBottom, 0);
    } catch (e: any) {
      setErrMsg(e?.message || "send failed");
    } finally {
      setLoading(false);
    }
  }

  // 初期ロード
  useEffect(() => {
    (async () => {
      await fetchStatus();
      await fetchThreads();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // メッセージ増えたら最下部へ（送信・返信）
  useEffect(() => {
    setTimeout(scrollMessagesBottom, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, loading]);

  // 日付区切り付きレンダ
  const renderedMessages = useMemo(() => {
    let lastDate = "";
    const out: React.ReactNode[] = [];

    messages.forEach((m, i) => {
      const date = toJstLabel(m.created_at);
      if (date && date !== lastDate) {
        lastDate = date;
        out.push(
          <div key={`d-${i}`} style={{ display: "flex", justifyContent: "center", margin: "10px 0" }}>
            <div
              style={{
                fontSize: 12,
                padding: "4px 10px",
                borderRadius: 999,
                border: "1px solid #ddd",
                background: "#fafafa",
              }}
            >
              {date.replaceAll("/", "") /* 20260122 みたいにしたいならここ調整 */ &&
              date.length === 10
                ? date.replace(/\//g, "")
                : date}
            </div>
          </div>
        );
      }

      const isMe = m.role === "user";
      const time = fmtHm(m.created_at);

      out.push(
        <div
          key={`${m.role}-${i}-${m.created_at}`}
          style={{
            display: "flex",
            justifyContent: isMe ? "flex-end" : "flex-start",
            margin: "6px 0",
          }}
        >
          <div
            style={{
              maxWidth: "78%",
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid #e5e5e5",
              background: isMe ? "#eef3ff" : "#fff",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              lineHeight: 1.5,
            }}
          >
            <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 6 }}>
              {isMe ? "あなた" : "さじかげん"}・{time}
            </div>
            <div>{m.content}</div>
          </div>
        </div>
      );
    });

    return out;
  }, [messages]);

  const contactUrl = useMemo(() => getContactUrl(), []);

  return (
    <div style={{ padding: 18 }}>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}>
        <div style={{ fontWeight: 700 }}>さじかげん｜税務相談</div>
      </div>

      {/* Header actions */}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginBottom: 8 }}>
        <Link
          href="/settings/billing"
          style={{
            border: "1px solid #ddd",
            padding: "8px 12px",
            borderRadius: 10,
            textDecoration: "none",
            color: "#111",
            background: "#fff",
          }}
        >
          プラン変更
        </Link>

        <a
          href={contactUrl}
          target="_blank"
          rel="noreferrer"
          style={{
            border: "1px solid #ddd",
            padding: "8px 12px",
            borderRadius: 10,
            textDecoration: "none",
            color: "#111",
            background: "#fff",
          }}
        >
          お問い合わせ
        </a>
      </div>

      {/* Plan box */}
      <div
        style={{
          border: "1px solid #ddd",
          borderRadius: 14,
          padding: 14,
          marginBottom: 10,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: "#fff",
        }}
      >
        <div style={{ fontWeight: 700 }}>
          プラン: {plan} / 残り{" "}
          {limitTalks != null && usedTalks != null ? Math.max(limitTalks - usedTalks, 0) : "?"} 回（
          {usedTalks ?? "?"}/{limitTalks ?? "?"}）
        </div>

        <button
          onClick={fetchStatus}
          style={{
            border: "1px solid #ddd",
            padding: "8px 12px",
            borderRadius: 10,
            background: "#fff",
            cursor: "pointer",
          }}
        >
          更新
        </button>
      </div>

      {errMsg ? (
        <div style={{ margin: "8px 0", color: "#b00020", fontSize: 13 }}>{errMsg}</div>
      ) : null}

      {/* Main layout */}
      <div
        style={{
          display: "flex",
          gap: 14,
          border: "1px solid #ddd",
          borderRadius: 14,
          padding: 12,
          background: "#fff",
          height: "calc(100vh - 220px)", // ここがスクロール体験の肝。ヘッダー分を引いた高さに固定。
          minHeight: 520,
        }}
      >
        {/* Left: threads */}
        <div
          style={{
            width: 300,
            minWidth: 260,
            border: "1px solid #eee",
            borderRadius: 12,
            padding: 10,
            display: "flex",
            flexDirection: "column",
            minHeight: 0, // scrollの必須
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontWeight: 700 }}>スレッド</div>
            <button
              onClick={newThreadLocalOnly}
              style={{
                border: "1px solid #ddd",
                padding: "6px 10px",
                borderRadius: 10,
                background: "#fff",
                cursor: "pointer",
              }}
            >
              新規
            </button>
          </div>

          <div style={{ height: 10 }} />

          <div
            style={{
              overflowY: "auto",
              paddingRight: 6,
              minHeight: 0,
              flex: 1,
            }}
          >
            {threads.map((t) => {
              const active = t.id === activeConversationId;
              return (
                <div
                  key={t.id}
                  onClick={() => selectThread(t.id)}
                  style={{
                    border: active ? "2px solid #9bb7ff" : "1px solid #e9e9e9",
                    borderRadius: 12,
                    padding: 10,
                    marginBottom: 10,
                    cursor: "pointer",
                    background: active ? "#f3f7ff" : "#fff",
                  }}
                >
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>{t.title}</div>
                  <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>{fmtYmd(t.created_at)}</div>
                  <div style={{ fontSize: 12, opacity: 0.8 }}>{t.preview || " "}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: chat */}
        <div
          style={{
            flex: 1,
            border: "1px solid #eee",
            borderRadius: 12,
            padding: 10,
            display: "flex",
            flexDirection: "column",
            minHeight: 0, // scrollの必須
          }}
        >
          {/* Top bar */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ fontWeight: 700 }}>{activeTitle}</div>

            <button
              onClick={renameThread}
              disabled={!activeConversationId}
              style={{
                border: "1px solid #ddd",
                padding: "6px 10px",
                borderRadius: 10,
                background: activeConversationId ? "#fff" : "#f4f4f4",
                cursor: activeConversationId ? "pointer" : "not-allowed",
              }}
            >
              名前変更
            </button>

            <div style={{ flex: 1 }} />

            {/* dialect */}
            <button
              onClick={() => setDialect("kansai")}
              style={{
                border: "1px solid #ddd",
                padding: "6px 10px",
                borderRadius: 10,
                background: dialect === "kansai" ? "#111" : "#fff",
                color: dialect === "kansai" ? "#fff" : "#111",
                cursor: "pointer",
              }}
            >
              関西弁
            </button>
            <button
              onClick={() => setDialect("standard")}
              style={{
                border: "1px solid #ddd",
                padding: "6px 10px",
                borderRadius: 10,
                background: dialect === "standard" ? "#111" : "#fff",
                color: dialect === "standard" ? "#fff" : "#111",
                cursor: "pointer",
              }}
            >
              標準語
            </button>

            {/* stance */}
            <button
              onClick={() => setStance("zubatto")}
              style={{
                border: "1px solid #ddd",
                padding: "6px 10px",
                borderRadius: 10,
                background: stance === "zubatto" ? "#111" : "#fff",
                color: stance === "zubatto" ? "#fff" : "#111",
                cursor: "pointer",
              }}
            >
              ズバっと
            </button>
            <button
              onClick={() => setStance("sanbo")}
              style={{
                border: "1px solid #ddd",
                padding: "6px 10px",
                borderRadius: 10,
                background: stance === "sanbo" ? "#111" : "#fff",
                color: stance === "sanbo" ? "#fff" : "#111",
                cursor: "pointer",
              }}
            >
              参謀
            </button>
          </div>

          <div style={{ height: 10 }} />

          {/* Messages scroll area */}
          <div
            ref={msgScrollRef}
            style={{
              flex: 1,
              overflowY: "auto",
              border: "1px solid #f0f0f0",
              borderRadius: 12,
              padding: 12,
              background: "#fff",
              minHeight: 0,
            }}
          >
            {renderedMessages.length > 0 ? (
              renderedMessages
            ) : (
              <div style={{ opacity: 0.7, fontSize: 13 }}>さじかげん：相談内容をどうぞ。</div>
            )}
          </div>

          <div style={{ height: 10 }} />

          {/* Input */}
          <div style={{ display: "flex", gap: 10 }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (!loading) sendMessage();
                }
              }}
              placeholder="相談内容を入力（Enterで送信）"
              style={{
                flex: 1,
                border: "1px solid #ddd",
                borderRadius: 12,
                padding: "12px 12px",
                outline: "none",
              }}
              disabled={loading}
            />
            <button
              onClick={sendMessage}
              disabled={loading}
              style={{
                border: "1px solid #ddd",
                borderRadius: 12,
                padding: "0 18px",
                background: loading ? "#f4f4f4" : "#fff",
                cursor: loading ? "not-allowed" : "pointer",
                fontWeight: 700,
              }}
            >
              送信
            </button>
          </div>

          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
            ※ 未契約/上限到達のときは送信不可（無駄打ち防止）。口調/モード切替は送信しない限りトークは消費しません。
          </div>
        </div>
      </div>
    </div>
  );
}
