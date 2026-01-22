"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
  title: string;
  createdAt: string;
  preview: string;
};

type StatusOk = { ok: true; plan: string; used_talks: number | null; limit_talks: number | null };
type StatusNg = { ok: false; error: string; used_talks?: number | null; limit_talks?: number | null };
type StatusRes = StatusOk | StatusNg;

type ChatOk = {
  ok: true;
  plan: string;
  used_talks: number | null;
  limit_talks: number | null;
  conversation_id: string | null;
  message: string;
};
type ChatNg = { ok: false; error: string; used_talks?: number | null; limit_talks?: number | null };
type ChatRes = ChatOk | ChatNg;

type Dialect = "kansai" | "standard";
type Stance = "zubatto" | "sanbo";

function clamp(s: string, n: number) {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n) + "…";
}
function toJstLabel(iso: string) {
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
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
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

function renderBoldInline(text: string): ReactNode {
  if (!text.includes("**")) return text;
  const parts = text.split("**");
  const out: ReactNode[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (i % 2 === 1) out.push(<strong key={i}>{p}</strong>);
    else out.push(<span key={i}>{p}</span>);
  }
  return <>{out}</>;
}

function stripCatchphraseIfThreePatterns(content: string): string {
  const hasAttack = content.includes("🍚");
  const hasDefense = content.includes("🧂守り") || content.includes("🧂🥄") || content.includes("🧂 守り");
  if (!(hasAttack && hasDefense)) return content;

  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t) continue;
    if (t.includes("とはいえ") || (t.includes("税務の世界") && t.includes("答え"))) lines.splice(i, 1);
    break;
  }
  return lines.join("\n").trimEnd();
}

function lineStyle(line: string): React.CSSProperties {
  const t = line.trimStart();
  const isTitle = t.startsWith("🧂") || t.startsWith("🍚") || t.startsWith("🧂🥄") || t.startsWith("🍚🥄");
  if (!isTitle) return { whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.6 };

  return {
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    lineHeight: 1.6,
    fontWeight: 800,
    background: "#eef5ff",
    border: "1px solid #cfe0ff",
    borderRadius: 10,
    padding: "8px 10px",
  };
}

function normalizeRole(x: unknown): Role {
  const r = String(x ?? "").trim().toLowerCase();
  return r === "user" ? "user" : "assistant";
}
function normalizeMessages(rows: any[]): MessageRow[] {
  return (rows ?? []).map((r) => ({
    id: String(r.id),
    conversation_id: String(r.conversation_id),
    role: normalizeRole(r.role),
    content: String(r.content ?? ""),
    created_at: String(r.created_at),
  })) as MessageRow[];
}

function isNearBottom(el: HTMLDivElement, px = 180) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < px;
}

export default function ChatClient() {
  const supabase = useMemo(() => getSupabaseClient(), []);
  const router = useRouter();

  const [loading, setLoading] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const [plan, setPlan] = useState<string>("(loading)");
  const [usedTalks, setUsedTalks] = useState<number | null>(null);
  const [limitTalks, setLimitTalks] = useState<number | null>(null);

  const [dialect, setDialect] = useState<Dialect>(() => (loadLocal("chat:dialect") === "standard" ? "standard" : "kansai"));
  const [stance, setStance] = useState<Stance>(() => (loadLocal("chat:stance") === "sanbo" ? "sanbo" : "zubatto"));

  const [threads, setThreads] = useState<ThreadItem[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(() => {
    const v = loadLocal("chat:activeConversationId");
    return v && isUuid(v) ? v : null;
  });

  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [input, setInput] = useState("");

  const msgsRef = useRef<HTMLDivElement | null>(null);

  // ループ防止：loginへ飛ぶのは1回だけ
  const redirectingRef = useRef(false);

  // 下にいる時だけ追従（送信時は強制 true）
  const shouldAutoScrollRef = useRef(true);

  const CONTACT_URL = process.env.NEXT_PUBLIC_CONTACT_URL || "mailto:support@example.com";

  const BTN: CSSProperties = {
    padding: "8px 12px",
    borderRadius: 10,
    border: "1px solid #ddd",
    background: "#fff",
    cursor: "pointer",
    pointerEvents: "auto",
  };

  const LINK_BTN: CSSProperties = {
    ...BTN,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    textDecoration: "none",
    color: "#111",
  };

  const toggleBtn = (active: boolean): CSSProperties => ({
    padding: "8px 10px",
    borderRadius: 10,
    border: "1px solid #ddd",
    background: active ? "#111" : "#fff",
    color: active ? "#fff" : "#111",
    cursor: "pointer",
    pointerEvents: "auto",
  });

  const scrollBottom = () => {
    const el = msgsRef.current;
    if (!el) return;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    });
    setTimeout(() => {
      el.scrollTop = el.scrollHeight;
    }, 60);
  };

  const getToken = async (): Promise<string | null> => {
    const { data, error } = await supabase.auth.getSession();
    if (!error && data.session?.access_token) return data.session.access_token;

    const refreshed = await supabase.auth.refreshSession().catch(() => null);
    return refreshed?.data?.session?.access_token ?? null;
  };

  const goLoginHard = async () => {
    if (redirectingRef.current) return;
    redirectingRef.current = true;
    try {
      await supabase.auth.signOut().catch(() => null);
    } finally {
      router.replace("/login?reason=expired");
    }
  };

  const handleAuthishError = async (raw: unknown) => {
    const msg = String((raw as any)?.message || raw || "");
    const low = msg.toLowerCase();
    if (
      low.includes("jwt expired") ||
      low.includes("invalid jwt") ||
      low.includes("invalid session") ||
      low.includes("not logged in")
    ) {
      setErrMsg("セッション切れてる。ログインし直してな。");
      await goLoginHard();
      return true;
    }
    return false;
  };

  const refreshStatus = async () => {
    setErrMsg(null);
    try {
      const token = await getToken();
      if (!token) return await handleAuthishError("Not logged in");

      const res = await fetch("/api/chat/status", {
        headers: { Authorization: `Bearer ${token}` },
      });

      const json = (await res.json().catch(() => null)) as StatusRes | null;
      if (!json) return setErrMsg(`status failed: ${res.status}`);
      if (json.ok !== true) return setErrMsg(json.error || `status failed: ${res.status}`);

      setPlan(json.plan);
      setUsedTalks(json.used_talks);
      setLimitTalks(json.limit_talks);
    } catch (e: any) {
      if (await handleAuthishError(e)) return;
      setErrMsg(e?.message || "status failed");
    }
  };

    const loadThreads = async () => {
    setErrMsg(null);
    try {
      const token = await getToken();
      if (!token) return await handleAuthishError("Not logged in");

      // ✅ 1クエリで一覧＋最終メッセージプレビューまで取る
      const { data, error } = await supabase
        .from("v_conversation_threads")
        .select("id, title, created_at, last_content, last_activity_at")
        .order("last_activity_at", { ascending: false })
        .limit(50);

      if (error) throw error;

      const items: ThreadItem[] = (data ?? []).map((r: any) => ({
        id: String(r.id),
        title: String(r.title ?? "(無題)"),
        createdAt: String(r.created_at),
        preview: r.last_content ? clamp(String(r.last_content), 24) : "",
      }));

      setThreads(items);

      if (items.length > 0) {
        if (!activeConversationId || !items.some((t) => t.id === activeConversationId)) {
          setActiveConversationId(items[0].id);
          saveLocal("chat:activeConversationId", items[0].id);
        }
      } else {
        setActiveConversationId(null);
        saveLocal("chat:activeConversationId", "");
      }
    } catch (e: any) {
      if (await handleAuthishError(e)) return;
      setErrMsg(e?.message || "load threads failed");
    }
  };

  const loadMessages = async (conversationId: string, opts?: { silent?: boolean }) => {
    setErrMsg(null);
    if (!opts?.silent) setLoading(true);

    try {
      const token = await getToken();
      if (!token) return await handleAuthishError("Not logged in");

      const { data, error } = await supabase
        .from("messages")
        .select("id, conversation_id, role, content, created_at")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true })
        .limit(700);

      if (error) throw error;

      const normalized = normalizeMessages(data as any[]);
      setMessages(normalized);

      if (shouldAutoScrollRef.current) scrollBottom();
    } catch (e: any) {
      if (await handleAuthishError(e)) return;
      setErrMsg(e?.message || "load messages failed");
    } finally {
      if (!opts?.silent) setLoading(false);
      setThinking(false);
    }
  };

  const newThread = () => {
    setActiveConversationId(null);
    saveLocal("chat:activeConversationId", "");
    setMessages([]);
    setErrMsg(null);
    setInput("");
  };

  const renameThread = async () => {
    if (!activeConversationId) return;
    const current = threads.find((t) => t.id === activeConversationId)?.title || "";
    const next = window.prompt("スレッドのタイトルを入力", current);
    if (next == null) return;
    const title = next.trim();
    if (!title) return;

    try {
      const token = await getToken();
      if (!token) return await handleAuthishError("Not logged in");

      const { error } = await supabase
        .from("conversations")
        .update({ summary: title, summary_updated_at: new Date().toISOString() })
        .eq("id", activeConversationId);

      if (error) throw error;

      setThreads((prev) => prev.map((t) => (t.id === activeConversationId ? { ...t, title } : t)));
    } catch (e: any) {
      if (await handleAuthishError(e)) return;
      setErrMsg(e?.message || "rename failed");
    }
  };

  const canSend = (() => {
    if (loading) return false;
    if (!limitTalks) return true;
    const used = usedTalks ?? 0;
    return used < limitTalks;
  })();

  const sendMessage = async () => {
    const text = input.trim();
    if (!text) return;

    setErrMsg(null);
    setLoading(true);
    setThinking(true);
    setInput("");

    // 送信時は必ず“下にいる”扱い
    shouldAutoScrollRef.current = true;

    const tempUser: MessageRow = {
      id: crypto.randomUUID(),
      conversation_id: activeConversationId || "temp",
      role: "user",
      content: text,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempUser]);
    scrollBottom();

    try {
      const token = await getToken();
      if (!token) return await handleAuthishError("Not logged in");

      const idempotencyKey = crypto.randomUUID();
      const body: any = { message: text, idempotencyKey, dialect, stance };
      if (activeConversationId) body.conversationId = activeConversationId;

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const json = (await res.json().catch(() => null)) as ChatRes | null;
      if (!json) throw new Error(`chat failed: ${res.status}`);
      if (json.ok !== true) {
        setErrMsg(json.error || `chat failed: ${res.status}`);
        return;
      }

      setPlan(json.plan);
      setUsedTalks(json.used_talks);
      setLimitTalks(json.limit_talks);

      const convId = json.conversation_id && isUuid(json.conversation_id) ? json.conversation_id : null;

      if (convId && !activeConversationId) {
        setActiveConversationId(convId);
        saveLocal("chat:activeConversationId", convId);
        setMessages((prev) => prev.map((m) => (m.conversation_id === "temp" ? { ...m, conversation_id: convId } : m)));
      }

      const effectiveConvId = convId || activeConversationId;
      await loadThreads();
      if (effectiveConvId) await loadMessages(effectiveConvId, { silent: true });
    } catch (e: any) {
      if (await handleAuthishError(e)) return;
      setErrMsg(String(e?.message || "send failed"));
    } finally {
      setLoading(false);
      setThinking(false);
    }
  };

  useEffect(() => {
    refreshStatus();
    loadThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!activeConversationId) return;
    loadMessages(activeConversationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId]);

  useEffect(() => saveLocal("chat:dialect", dialect), [dialect]);
  useEffect(() => saveLocal("chat:stance", stance), [stance]);

  const activeTitle = (activeConversationId && threads.find((t) => t.id === activeConversationId)?.title) || "(新規)";
  const canRename = Boolean(activeConversationId);

  const badge = (() => {
    if (!limitTalks) return "";
    const used = usedTalks ?? 0;
    const left = Math.max(0, limitTalks - used);
    return `プラン: ${plan} / 残り ${left} 回（${used}/${limitTalks}）`;
  })();

  const ROOT_W = "min(1400px, 100%)";
  const THREAD_W = 330;

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#fff" }}>
      <div style={{ padding: "10px 16px", position: "relative", zIndex: 30, pointerEvents: "auto" }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <div style={{ flex: 1 }} />
          <div style={{ textAlign: "center", fontWeight: 900, fontSize: 18 }}>
            さじかげん 🍚🥄｜税務相談{" "}
            <span style={{ fontSize: 12, fontWeight: 700, color: "#666" }}>～あなたの欲しい ちょうどいい さじかげん～</span>
          </div>
          <div style={{ flex: 1, display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <Link href="/settings/billing" style={LINK_BTN}>プラン変更</Link>
            <a href={CONTACT_URL} style={LINK_BTN} target={CONTACT_URL.startsWith("http") ? "_blank" : undefined} rel="noreferrer">お問い合わせ</a>
            <button
  type="button"
  onPointerDown={async (e) => {
    e.preventDefault();
    await supabase.auth.signOut().catch(() => null);
    router.replace("/login");
  }}
  onTouchStart={async (e) => {
    e.preventDefault();
    await supabase.auth.signOut().catch(() => null);
    router.replace("/login");
  }}
  style={BTN}
>
  ログアウト
</button>
          </div>
        </div>

        <div style={{ marginTop: 10, display: "flex", justifyContent: "center" }}>
          <div style={{ width: ROOT_W, border: "1px solid #ddd", borderRadius: 12, padding: "10px 12px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <div style={{ fontWeight: 800 }}>{badge || "プラン: (loading)"}</div>
            <button type="button" onPointerDown={(e) => { e.preventDefault(); refreshStatus(); }} onTouchStart={(e) => { e.preventDefault(); refreshStatus(); }} style={BTN}>更新</button>
          </div>
        </div>

        {errMsg && <div style={{ marginTop: 8, color: "#b00020", fontSize: 13 }}>{errMsg}</div>}
      </div>

      <div style={{ flex: 1, display: "flex", justifyContent: "center", padding: "0 16px 16px", minHeight: 0 }}>
        <div style={{ width: ROOT_W, border: "1px solid #ddd", borderRadius: 12, display: "flex", overflow: "hidden", minHeight: 0 }}>
          <div style={{ width: THREAD_W, borderRight: "1px solid #eee", display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div style={{ padding: 12, display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #eee" }}>
              <div style={{ fontWeight: 900 }}>スレッド</div>
              <button type="button" onPointerDown={(e) => { e.preventDefault(); newThread(); }} onTouchStart={(e) => { e.preventDefault(); newThread(); }} style={BTN}>新規</button>
            </div>

            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 10, background: "#fafafa" }}>
              {threads.map((t) => {
                const active = t.id === activeConversationId;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onPointerDown={(e) => { e.preventDefault(); setActiveConversationId(t.id); saveLocal("chat:activeConversationId", t.id); }}
                    onTouchStart={(e) => { e.preventDefault(); setActiveConversationId(t.id); saveLocal("chat:activeConversationId", t.id); }}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      padding: 10,
                      marginBottom: 8,
                      borderRadius: 10,
                      border: active ? "2px solid #9dbbff" : "1px solid #e5e5e5",
                      background: active ? "#eef5ff" : "#fff",
                      cursor: "pointer",
                      pointerEvents: "auto",
                    }}
                  >
                    <div style={{ fontWeight: 900, marginBottom: 6 }}>{t.title}</div>
                    <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>{toJstLabel(t.createdAt)} {toHm(t.createdAt)}</div>
                    <div style={{ fontSize: 12, color: t.preview ? "#333" : "#999" }}>{t.preview || "(プレビューなし)"}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div style={{ padding: 12, borderBottom: "1px solid #eee", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, background: "#fff", position: "relative", zIndex: 20 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <div style={{ fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{activeTitle}</div>
                <div style={{ fontSize: 12, color: "#666", whiteSpace: "nowrap" }}>（{dialect}/{stance}）</div>
              </div>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  onPointerDown={(e) => { e.preventDefault(); if (canRename) renameThread(); }}
                  onTouchStart={(e) => { e.preventDefault(); if (canRename) renameThread(); }}
                  aria-disabled={!canRename}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: "1px solid #ddd",
                    background: canRename ? "#fff" : "#f5f5f5",
                    color: "#111",
                    opacity: canRename ? 1 : 0.5,
                    cursor: canRename ? "pointer" : "not-allowed",
                    pointerEvents: "auto",
                  }}
                >
                  ✏️ タイトル
                </button>

                <button type="button" onPointerDown={(e) => { e.preventDefault(); setDialect("kansai"); }} onTouchStart={(e) => { e.preventDefault(); setDialect("kansai"); }} style={toggleBtn(dialect === "kansai")}>関西弁</button>
                <button type="button" onPointerDown={(e) => { e.preventDefault(); setDialect("standard"); }} onTouchStart={(e) => { e.preventDefault(); setDialect("standard"); }} style={toggleBtn(dialect === "standard")}>標準語</button>
                <button type="button" onPointerDown={(e) => { e.preventDefault(); setStance("zubatto"); }} onTouchStart={(e) => { e.preventDefault(); setStance("zubatto"); }} style={toggleBtn(stance === "zubatto")}>ズバっと</button>
                <button type="button" onPointerDown={(e) => { e.preventDefault(); setStance("sanbo"); }} onTouchStart={(e) => { e.preventDefault(); setStance("sanbo"); }} style={toggleBtn(stance === "sanbo")}>参謀</button>
              </div>
            </div>

            <div
              ref={msgsRef}
              onScroll={() => {
                const el = msgsRef.current;
                if (!el) return;
                shouldAutoScrollRef.current = isNearBottom(el);
              }}
              style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 14px", background: "#fff" }}
            >
              {messages.map((m, idx) => {
                const role = normalizeRole((m as any).role);
                const isUser = role === "user";
                const raw = String(m.content ?? "");
                const content = isUser ? raw : stripCatchphraseIfThreePatterns(raw);

                return (
                  <div key={m.id ?? idx} style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start", margin: "10px 0" }}>
                    <div style={{ maxWidth: "86%", padding: "10px 12px", borderRadius: 12, border: "1px solid #e5e5e5", background: isUser ? "#eef5ff" : "#fff" }}>
                      {isUser ? (
                        <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.6 }}>{content}</div>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          {content.replace(/\r\n/g, "\n").split("\n").map((line, i) => {
                            if (!line.trim()) return <div key={i} style={{ height: 4 }} />;
                            return (
                              <div key={i} style={lineStyle(line)}>
                                {renderBoldInline(line)}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: "#777", marginTop: 8, textAlign: "right" }}>{toHm(m.created_at)}</div>
                    </div>
                  </div>
                );
              })}

              {thinking && (
                <div style={{ display: "flex", justifyContent: "flex-start", margin: "10px 0" }}>
                  <div style={{ maxWidth: "86%", padding: "10px 12px", borderRadius: 12, border: "1px solid #e5e5e5", background: "#fff" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#666" }}>
                      <span>考え中</span>
                      <span className="dots" aria-hidden="true">...</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div style={{ padding: 12, borderTop: "1px solid #eee", display: "flex", gap: 10, alignItems: "center", background: "#fff" }}>
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (canSend) sendMessage();
                  }
                }}
                placeholder="相談内容を入力（Enterで送信）"
                style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: "1px solid #ddd" }}
                disabled={!canSend}
              />
              <button
                type="button"
                onPointerDown={(e) => { e.preventDefault(); if (canSend) sendMessage(); }}
                onTouchStart={(e) => { e.preventDefault(); if (canSend) sendMessage(); }}
                disabled={!canSend}
                style={{
                  padding: "10px 16px",
                  borderRadius: 10,
                  border: "1px solid #ddd",
                  background: "#fff",
                  cursor: !canSend ? "not-allowed" : "pointer",
                  opacity: !canSend ? 0.6 : 1,
                }}
              >
                送信
              </button>
            </div>

            <div style={{ padding: "0 12px 12px", fontSize: 12, color: "#777" }}>
              ※ 口調/モード切替は次の送信から反映。
            </div>
          </div>
        </div>
      </div>

      <style jsx global>{`
        .dots {
          display: inline-block;
          width: 18px;
          text-align: left;
          animation: dotty 1.2s infinite steps(4, end);
        }
        @keyframes dotty {
          0% { width: 0; }
          25% { width: 6px; }
          50% { width: 12px; }
          75% { width: 18px; }
          100% { width: 0; }
        }
      `}</style>
    </div>
  );
}
