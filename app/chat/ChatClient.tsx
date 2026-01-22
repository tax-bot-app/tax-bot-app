"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { getSupabaseClient } from "@/app/lib/supabaseClient";

type Role = "user" | "assistant";

type MessageRow = {
  id: string;
  conversation_id: string;
  role: Role;
  content: string;
  created_at: string;
};

type ConversationRow = {
  id: string;
  summary: string | null;
  created_at: string;
  summary_updated_at?: string | null;
};

type ThreadItem = {
  id: string;
  title: string; // 表示名（summary）
  createdAt: string;
  preview: string; // 最新メッセの頭20文字（なければ空）
};

type StatusOk = {
  ok: true;
  plan: string;
  used_talks: number | null;
  limit_talks: number | null;
};

type StatusNg = {
  ok: false;
  error: string;
  used_talks?: number | null;
  limit_talks?: number | null;
};

type StatusRes = StatusOk | StatusNg;

type ChatOk = {
  ok: true;
  plan: string;
  used_talks: number | null;
  limit_talks: number | null;
  conversation_id: string | null;
  message: string;
};

type ChatNg = {
  ok: false;
  error: string;
  used_talks?: number | null;
  limit_talks?: number | null;
};

type ChatRes = ChatOk | ChatNg;

type Dialect = "kansai" | "standard";
type Stance = "zubatto" | "sanbo";

function clamp(s: string, n: number) {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n) + "…";
}

function toJstLabel(iso: string) {
  // 例: 2026/01/22
  try {
    const d = new Date(iso);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}/${m}/${day}`;
  } catch {
    return "";
  }
}

function toHm(iso: string) {
  // 例: 12:34
  try {
    const d = new Date(iso);
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    return `${h}:${m}`;
  } catch {
    return "";
  }
}

function isUuid(s: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s
  );
}

function loadLocal(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function saveLocal(key: string, val: string) {
  try {
    localStorage.setItem(key, val);
  } catch {}
}

export default function ChatClient() {
  const supabase = useMemo(() => getSupabaseClient(), []);

  const [loading, setLoading] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const [plan, setPlan] = useState<string>("(loading)");
  const [usedTalks, setUsedTalks] = useState<number | null>(null);
  const [limitTalks, setLimitTalks] = useState<number | null>(null);

  const [dialect, setDialect] = useState<Dialect>(() => {
    const v = loadLocal("chat:dialect");
    return v === "standard" ? "standard" : "kansai";
  });
  const [stance, setStance] = useState<Stance>(() => {
    const v = loadLocal("chat:stance");
    return v === "sanbo" ? "sanbo" : "zubatto";
  });

  const [threads, setThreads] = useState<ThreadItem[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(() => {
    const v = loadLocal("chat:activeConversationId");
    return v && isUuid(v) ? v : null;
  });

  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [input, setInput] = useState("");

  const listRef = useRef<HTMLDivElement | null>(null);
  const msgsRef = useRef<HTMLDivElement | null>(null);

  const CONTACT_URL =
    process.env.NEXT_PUBLIC_CONTACT_URL || "mailto:support@example.com";

  const scrollMessagesBottom = () => {
    const el = msgsRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  };

  const refreshStatus = async () => {
    setErrMsg(null);
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;

      const token = data.session?.access_token;
      if (!token) {
        setPlan("(not logged in)");
        setUsedTalks(null);
        setLimitTalks(null);
        return;
      }

      const res = await fetch("/api/chat/status", {
        headers: { Authorization: `Bearer ${token}` },
      });

      const json = (await res.json().catch(() => null)) as StatusRes | null;

      if (!json) {
        setErrMsg(`status failed: ${res.status}`);
        return;
      }
      if (json.ok !== true) {
        setErrMsg(json.error || `status failed: ${res.status}`);
        return;
      }

      // ✅ TSを100%納得させる
      const okJson: Extract<StatusRes, { ok: true }> = json;

      setPlan(okJson.plan);
      setUsedTalks(okJson.used_talks);
      setLimitTalks(okJson.limit_talks);
    } catch (e: any) {
      setErrMsg(e?.message || "status failed");
    }
  };

  const loadThreads = async () => {
    setErrMsg(null);
    try {
      const { data: sess, error: sessErr } = await supabase.auth.getSession();
      if (sessErr) throw sessErr;

      const token = sess.session?.access_token;
      if (!token) return;

      // conversations（RLS前提）
      const { data: convs, error: convErr } = await supabase
        .from("conversations")
        .select("id, summary, created_at, summary_updated_at")
        .order("created_at", { ascending: false })
        .limit(50);

      if (convErr) throw convErr;

      const base: ThreadItem[] = (convs ?? []).map((c: ConversationRow) => ({
        id: c.id,
        title: c.summary?.trim() ? c.summary!.trim() : "(無題)",
        createdAt: c.created_at,
        preview: "",
      }));

      // 最新メッセの頭20文字（N+1になるけど、最大50件＆各1件だけで軽め）
      const previews = await Promise.all(
        base.map(async (t) => {
          const { data: lastMsg } = await supabase
            .from("messages")
            .select("content, created_at")
            .eq("conversation_id", t.id)
            .order("created_at", { ascending: false })
            .limit(1);

          const head = lastMsg?.[0]?.content ? clamp(lastMsg[0].content, 20) : "";
          return { ...t, preview: head };
        })
      );

      // summary_updated_at があればそれ優先で並び替え（無ければ createdAt）
      previews.sort((a, b) => {
        // ここは“概ね最近順”でOK。厳密にやるなら conversations に updated_at を持たせる。
        return b.createdAt.localeCompare(a.createdAt);
      });

      setThreads(previews);

      // activeConversationId が無効なら先頭を選ぶ（ただし空ならnull）
      if (previews.length > 0) {
        if (!activeConversationId || !previews.some((t) => t.id === activeConversationId)) {
          setActiveConversationId(previews[0].id);
          saveLocal("chat:activeConversationId", previews[0].id);
        }
      } else {
        setActiveConversationId(null);
        saveLocal("chat:activeConversationId", "");
      }
    } catch (e: any) {
      setErrMsg(e?.message || "load threads failed");
    }
  };

  const loadMessages = async (conversationId: string) => {
    setErrMsg(null);
    setLoading(true);
    try {
      const { data: sess, error: sessErr } = await supabase.auth.getSession();
      if (sessErr) throw sessErr;
      if (!sess.session?.access_token) throw new Error("Not logged in");

      const { data, error } = await supabase
        .from("messages")
        .select("id, conversation_id, role, content, created_at")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true })
        .limit(500);

      if (error) throw error;
      setMessages((data ?? []) as MessageRow[]);
      setTimeout(scrollMessagesBottom, 0);
    } catch (e: any) {
      setErrMsg(e?.message || "load messages failed");
    } finally {
      setLoading(false);
    }
  };

  const newThread = () => {
    // ✅ ここではDB作らない。activeConversationIdをnullにして「未作成」状態へ
    setActiveConversationId(null);
    saveLocal("chat:activeConversationId", "");
    setMessages([]);
    setErrMsg(null);
    setInput("");
    setTimeout(() => {
      // 右側を上に戻す
      const el = msgsRef.current;
      if (el) el.scrollTop = 0;
    }, 0);
  };

  const renameThread = async () => {
    if (!activeConversationId) return;
    const current = threads.find((t) => t.id === activeConversationId)?.title || "";
    const next = window.prompt("スレッド名を入力", current);
    if (next == null) return;
    const title = next.trim();
    if (!title) return;

    try {
      const { error } = await supabase
        .from("conversations")
        .update({
          summary: title,
          summary_updated_at: new Date().toISOString(),
        })
        .eq("id", activeConversationId);

      if (error) throw error;

      // ローカル反映
      setThreads((prev) =>
        prev.map((t) => (t.id === activeConversationId ? { ...t, title } : t))
      );
    } catch (e: any) {
      setErrMsg(e?.message || "rename failed");
    }
  };

  const sendMessage = async () => {
    const text = input.trim();
    if (!text) return;

    setErrMsg(null);
    setLoading(true);
    setInput("");

    // 先にUIへユーザー発言を出す（会話IDなしでもOK）
    const tempUser: MessageRow = {
      id: crypto.randomUUID(),
      conversation_id: activeConversationId || "temp",
      role: "user",
      content: text,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempUser]);
    setTimeout(scrollMessagesBottom, 0);

    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;

      const token = data.session?.access_token;
      if (!token) throw new Error("Not logged in");

      const idempotencyKey = crypto.randomUUID();

      const body: any = {
        message: text,
        idempotencyKey,
        dialect,
        stance,
      };

      // ✅ 既に会話IDがある場合だけ送る
      if (activeConversationId) body.conversationId = activeConversationId;

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });

      const json = (await res.json().catch(() => null)) as ChatRes | null;
      if (!json) throw new Error(`chat failed: ${res.status}`);

      if (json.ok !== true) {
        // 失敗なら“AI返答なし”で表示する（ユーザーの発言は残ってる想定）
        setErrMsg(json.error || `chat failed: ${res.status}`);
        return;
      }

      // ✅ ok:true に確定
      const okJson: Extract<ChatRes, { ok: true }> = json;

      // ステータス反映
      setPlan(okJson.plan);
      setUsedTalks(okJson.used_talks);
      setLimitTalks(okJson.limit_talks);

      // ✅ 初回送信で新規会話が作られた場合、activeConversationId を確定させる
      const newConvId = okJson.conversation_id;
      if (newConvId && isUuid(newConvId)) {
        if (!activeConversationId) {
          setActiveConversationId(newConvId);
          saveLocal("chat:activeConversationId", newConvId);

          // temp の conversation_id を新IDへ置換
          setMessages((prev) =>
            prev.map((m) =>
              m.conversation_id === "temp" ? { ...m, conversation_id: newConvId } : m
            )
          );

          // スレッド一覧を更新（新規が増える）
          await loadThreads();
        } else {
          // 既存なら preview 更新のために threads を軽く更新
          setThreads((prev) =>
            prev.map((t) =>
              t.id === activeConversationId ? { ...t, preview: clamp(text, 20) } : t
            )
          );
        }
      }

      // AI返答を追加（DB保存済み想定）
      const tempAsst: MessageRow = {
        id: crypto.randomUUID(),
        conversation_id: newConvId || activeConversationId || "temp",
        role: "assistant",
        content: okJson.message,
        created_at: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, tempAsst]);
      setTimeout(scrollMessagesBottom, 0);
    } catch (e: any) {
      setErrMsg(e?.message || "send failed");
    } finally {
      setLoading(false);
    }
  };

  // 初期ロード
  useEffect(() => {
    refreshStatus();
    loadThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // activeConversationId が変わったら読み込み
  useEffect(() => {
    if (!activeConversationId) return;
    loadMessages(activeConversationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId]);

  // dialect/stance 永続化
  useEffect(() => {
    saveLocal("chat:dialect", dialect);
  }, [dialect]);
  useEffect(() => {
    saveLocal("chat:stance", stance);
  }, [stance]);

  // --- render helpers ---
  const renderMessages = () => {
    let lastDate = "";
    const out: ReactNode[] = [];

    messages.forEach((m, i) => {
      const date = toJstLabel(m.created_at);
      if (date && date !== lastDate) {
        lastDate = date;
        out.push(
          <div
            key={`d-${i}`}
            style={{ display: "flex", justifyContent: "center", margin: "10px 0" }}
          >
            <div
              style={{
                fontSize: 12,
                padding: "4px 10px",
                borderRadius: 999,
                border: "1px solid #ddd",
                background: "#f7f7f7",
                color: "#444",
              }}
            >
              {date}
            </div>
          </div>
        );
      }

      const isUser = m.role === "user";
      out.push(
        <div
          key={m.id}
          style={{
            display: "flex",
            justifyContent: isUser ? "flex-end" : "flex-start",
            margin: "8px 0",
          }}
        >
          <div
            style={{
              maxWidth: "78%",
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid #e5e5e5",
              background: isUser ? "#eef5ff" : "#fff",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              lineHeight: 1.5,
            }}
          >
            <div style={{ fontSize: 14 }}>{m.content}</div>
            <div style={{ fontSize: 11, color: "#777", marginTop: 6, textAlign: "right" }}>
              {toHm(m.created_at)}
            </div>
          </div>
        </div>
      );
    });

    return out;
  };

  const activeTitle =
    (activeConversationId && threads.find((t) => t.id === activeConversationId)?.title) ||
    "(新規)";

  const activePreview =
    (activeConversationId && threads.find((t) => t.id === activeConversationId)?.preview) ||
    "";

  const badge = (() => {
    if (!limitTalks) return "";
    const used = usedTalks ?? 0;
    const left = Math.max(0, limitTalks - used);
    return `プラン: ${plan} / 残り ${left} 回（${used}/${limitTalks}）`;
  })();

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "#fff",
      }}
    >
      {/* top header */}
      <div style={{ padding: "18px 16px 10px", textAlign: "center" }}>
        <div style={{ fontSize: 18, fontWeight: 700 }}>さじかげん｜税務相談</div>

        <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <Link href="/settings/billing">
            <button style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #ddd" }}>
              プラン変更
            </button>
          </Link>

          <a
            href={CONTACT_URL}
            target={CONTACT_URL.startsWith("http") ? "_blank" : undefined}
            rel="noreferrer"
          >
            <button style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #ddd" }}>
              お問い合わせ
            </button>
          </a>
        </div>

        <div
          style={{
            marginTop: 10,
            display: "flex",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              width: "min(980px, 100%)",
              border: "1px solid #ddd",
              borderRadius: 12,
              padding: "12px 14px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 10,
            }}
          >
            <div style={{ fontWeight: 700 }}>{badge || "プラン: (loading)"}</div>
            <button
              onClick={refreshStatus}
              style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #ddd" }}
            >
              更新
            </button>
          </div>
        </div>

        {errMsg && (
          <div style={{ marginTop: 10, color: "#b00020", fontSize: 13 }}>{errMsg}</div>
        )}
      </div>

      {/* main */}
      <div
        style={{
          flex: 1,
          display: "flex",
          justifyContent: "center",
          padding: "0 16px 16px",
        }}
      >
        <div
          style={{
            width: "min(980px, 100%)",
            border: "1px solid #ddd",
            borderRadius: 12,
            display: "flex",
            overflow: "hidden",
            minHeight: 0,
          }}
        >
          {/* left threads */}
          <div
            style={{
              width: 280,
              borderRight: "1px solid #eee",
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
            }}
          >
            <div
              style={{
                padding: 12,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                borderBottom: "1px solid #eee",
              }}
            >
              <div style={{ fontWeight: 700 }}>スレッド</div>
              <button
                onClick={newThread}
                style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #ddd" }}
              >
                新規
              </button>
            </div>

            <div
              ref={listRef}
              style={{
                flex: 1,
                overflowY: "auto",
                padding: 10,
                background: "#fafafa",
              }}
            >
              {threads.length === 0 && (
                <div style={{ color: "#666", fontSize: 13, padding: 8 }}>
                  まだスレッドがありません（最初の送信で作成されます）
                </div>
              )}

              {threads.map((t) => {
                const active = t.id === activeConversationId;
                return (
                  <button
                    key={t.id}
                    onClick={() => {
                      setActiveConversationId(t.id);
                      saveLocal("chat:activeConversationId", t.id);
                    }}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      padding: 10,
                      marginBottom: 8,
                      borderRadius: 10,
                      border: active ? "2px solid #9dbbff" : "1px solid #e5e5e5",
                      background: active ? "#eef5ff" : "#fff",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>{t.title}</div>
                    <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>
                      {toJstLabel(t.createdAt)} {toHm(t.createdAt)}
                    </div>
                    {t.preview ? (
                      <div style={{ fontSize: 12, color: "#333" }}>{t.preview}</div>
                    ) : (
                      <div style={{ fontSize: 12, color: "#999" }}>(プレビューなし)</div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* right chat */}
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
            }}
          >
            {/* chat header row */}
            <div
              style={{
                padding: 12,
                borderBottom: "1px solid #eee",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
              }}
            >
              <div style={{ fontWeight: 700, overflow: "hidden" }}>
                <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {activeTitle}
                </div>
                {activePreview ? (
                  <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>
                    {activePreview}
                  </div>
                ) : null}
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button
                  onClick={renameThread}
                  disabled={!activeConversationId}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: "1px solid #ddd",
                    opacity: activeConversationId ? 1 : 0.5,
                    cursor: activeConversationId ? "pointer" : "not-allowed",
                  }}
                >
                  名前変更
                </button>

                <button
                  onClick={() => setDialect("kansai")}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: "1px solid #ddd",
                    background: dialect === "kansai" ? "#111" : "#fff",
                    color: dialect === "kansai" ? "#fff" : "#111",
                  }}
                >
                  関西弁
                </button>
                <button
                  onClick={() => setDialect("standard")}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: "1px solid #ddd",
                    background: dialect === "standard" ? "#111" : "#fff",
                    color: dialect === "standard" ? "#fff" : "#111",
                  }}
                >
                  標準語
                </button>

                <button
                  onClick={() => setStance("zubatto")}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: "1px solid #ddd",
                    background: stance === "zubatto" ? "#111" : "#fff",
                    color: stance === "zubatto" ? "#fff" : "#111",
                  }}
                >
                  ズバっと
                </button>
                <button
                  onClick={() => setStance("sanbo")}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: "1px solid #ddd",
                    background: stance === "sanbo" ? "#111" : "#fff",
                    color: stance === "sanbo" ? "#fff" : "#111",
                  }}
                >
                  参謀
                </button>
              </div>
            </div>

            {/* message list */}
            <div
              ref={msgsRef}
              style={{
                flex: 1,
                overflowY: "auto",
                padding: "12px 14px",
                background: "#fff",
                minHeight: 0,
              }}
            >
              {messages.length === 0 ? (
                <div style={{ color: "#666", fontSize: 14 }}>
                  さじかげん：相談内容をどうぞ。
                  <div style={{ marginTop: 8, fontSize: 12, color: "#999" }}>
                    ※「新規」を押しただけではスレッドは作られません。最初の送信で作成されます。
                  </div>
                </div>
              ) : (
                renderMessages()
              )}
            </div>

            {/* input */}
            <div
              style={{
                padding: 12,
                borderTop: "1px solid #eee",
                display: "flex",
                gap: 10,
                alignItems: "center",
              }}
            >
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
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid #ddd",
                }}
                disabled={loading}
              />
              <button
                onClick={sendMessage}
                disabled={loading}
                style={{
                  padding: "10px 16px",
                  borderRadius: 10,
                  border: "1px solid #ddd",
                  background: "#fff",
                  cursor: loading ? "not-allowed" : "pointer",
                }}
              >
                送信
              </button>
            </div>

            <div style={{ padding: "0 12px 12px", fontSize: 12, color: "#777" }}>
              ※ 未契約/上限到達のときは送信不可（無駄打ち防止）。口調/モード切替は送信しない限りトークに影響しません。
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
