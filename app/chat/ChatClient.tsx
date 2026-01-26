"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getSupabaseClient } from "@/app/lib/supabaseClient";
import { yuji } from "@/app/layout";

type Role = "user" | "assistant";

type MessageRow = {
  id: string;
  conversation_id: string;
  role: Role;
  content: string;
  created_at: string;
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
  const isTitle =
    t.startsWith("🥄") ||
    t.startsWith("🧂") ||
    t.startsWith("🍚") ||
    t.startsWith("🧂🥄") ||
    t.startsWith("🍚🥄");
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

  // ✅ 初期値：標準語 × 参謀（保存済みがあればそれを尊重）
  const [dialect, setDialect] = useState<Dialect>(() => (loadLocal("chat:dialect") === "kansai" ? "kansai" : "standard"));
  const [stance, setStance] = useState<Stance>(() => (loadLocal("chat:stance") === "zubatto" ? "zubatto" : "sanbo"));

  const [threads, setThreads] = useState<ThreadItem[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(() => {
    const v = loadLocal("chat:activeConversationId");
    return v && isUuid(v) ? v : null;
  });

  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [input, setInput] = useState("");

  // UI states
  const [spMenuOpen, setSpMenuOpen] = useState(false);
  const [spThreadsOpen, setSpThreadsOpen] = useState(false);
  const [chatSettingsOpen, setChatSettingsOpen] = useState(false);
  const [aiProfileOpen, setAiProfileOpen] = useState(false);

  // PC/Tablet: サイドバー畳む
  const [sidebarMode, setSidebarMode] = useState<"open" | "collapsed">(
    () => (loadLocal("chat:sidebar") === "collapsed" ? "collapsed" : "open")
  );

  const clearChatUiState = () => {
    setThreads([]);
    setMessages([]);
    setActiveConversationId(null);
    try {
      localStorage.removeItem("chat:activeConversationId");
    } catch {}
  };

  const msgsRef = useRef<HTMLDivElement | null>(null);
  const redirectingRef = useRef(false);
  const shouldAutoScrollRef = useRef(true);

  const CONTACT_URL = process.env.NEXT_PUBLIC_CONTACT_URL || "mailto:support@example.com";

  // ✅ public/ai-noguchi.jpg
  const AI_AVATAR_URL = "/ai-noguchi.jpg";

  const BTN: CSSProperties = {
    padding: "8px 12px",
    borderRadius: 10,
    border: "1px solid #ddd",
    background: "#fff",
    cursor: "pointer",
    pointerEvents: "auto",
    whiteSpace: "nowrap",
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
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid #ddd",
    background: active ? "#111" : "#fff",
    color: active ? "#fff" : "#111",
    cursor: "pointer",
    pointerEvents: "auto",
    whiteSpace: "nowrap",
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
      clearChatUiState();
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

  const maybeRedirectFromApiError = async (res: Response, json: any) => {
    if (res.status === 401) {
      const msg = String(json?.error || "Invalid session");
      if (await handleAuthishError(msg)) return true;
    }
    if (json && json.ok === false && typeof json.error === "string") {
      if (await handleAuthishError(json.error)) return true;
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
      if (await maybeRedirectFromApiError(res, json)) return;
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

      const { data: u, error: uErr } = await supabase.auth.getUser();
      if (uErr || !u?.user?.id) return await handleAuthishError("Not logged in");
      const userId = u.user.id;

      const { data, error } = await supabase
        .from("v_conversation_threads")
        .select("id, user_id, title, created_at, last_content, last_activity_at")
        .eq("user_id", userId)
        .order("last_activity_at", { ascending: false })
        .limit(50);

      if (error) throw error;

      const items: ThreadItem[] = (data ?? []).map((r: any) => ({
        id: String(r.id),
        title: String(r.title ?? "(無題)"),
        createdAt: String(r.created_at),
        preview: r.last_content ? clamp(String(r.last_content), 36) : "",
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
        .order("id", { ascending: true })
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
    setSpThreadsOpen(false);
    setChatSettingsOpen(false);
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

      const { data: u, error: uErr } = await supabase.auth.getUser();
      if (uErr || !u?.user?.id) return await handleAuthishError("Not logged in");
      const userId = u.user.id;

      const { error } = await supabase
        .from("conversations")
        .update({ summary: title, summary_updated_at: new Date().toISOString() })
        .eq("id", activeConversationId)
        .eq("user_id", userId);

      if (error) throw error;

      setThreads((prev) => prev.map((t) => (t.id === activeConversationId ? { ...t, title } : t)));
      setChatSettingsOpen(false);
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

      if (await maybeRedirectFromApiError(res, json)) return;
      if (!json) throw new Error(`chat failed: ${res.status}`);

      if (json.ok !== true) {
        setErrMsg(json.error || `chat failed: ${res.status}`);
        return;
      }

      const assistantId = crypto.randomUUID();
      const tempAssistant: MessageRow = {
        id: assistantId,
        conversation_id: activeConversationId || "temp",
        role: "assistant",
        content: "",
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, tempAssistant]);
      scrollBottom();

      const full = String((json as any).message ?? "");
      const parts = full
        .split(/(?<=[。！？\n])/g)
        .map((s) => s)
        .filter((s) => s.length > 0);

      await new Promise<void>((resolve) => {
        let i = 0;

        const tick = () => {
          if (i >= parts.length) return resolve();

          const chunk = parts[i++];
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: (m.content ?? "") + chunk } : m))
          );

          shouldAutoScrollRef.current = true;
          scrollBottom();

          setTimeout(tick, 160);
        };

        tick();
      });

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

  const doLogout = async () => {
    await supabase.auth.signOut().catch(() => null);
    clearChatUiState();
    router.replace("/login");
  };

  const activeTitle = (activeConversationId && threads.find((t) => t.id === activeConversationId)?.title) || "(新規)";
  const canRename = Boolean(activeConversationId);

  const badge = (() => {
    if (!limitTalks) return "";
    const used = usedTalks ?? 0;
    const left = Math.max(0, limitTalks - used);
    return `プラン: ${plan} / 残り ${left} 回（${used}/${limitTalks}）`;
  })();

  useEffect(() => {
    const d = loadLocal("chat:dialect");
    const s = loadLocal("chat:stance");
    if (!d) saveLocal("chat:dialect", dialect);
    if (!s) saveLocal("chat:stance", stance);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => saveLocal("chat:dialect", dialect), [dialect]);
  useEffect(() => saveLocal("chat:stance", stance), [stance]);
  useEffect(() => saveLocal("chat:sidebar", sidebarMode), [sidebarMode]);

  useEffect(() => {
    const saved = loadLocal("chat:sidebar");
    if (saved) return;
    const w = window.innerWidth;
    if (w >= 761 && w < 980) setSidebarMode("collapsed");
  }, []);

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

  const openUrl = (url: string) => {
    if (url.startsWith("http")) window.open(url, "_blank", "noreferrer");
    else window.location.href = url;
  };

  const setRecommendedMode = () => {
    setDialect("standard");
    setStance("sanbo");
    saveLocal("chat:dialect", "standard");
    saveLocal("chat:stance", "sanbo");
  };

  return (
    <div className="appRoot">
      {/* ===== Header ===== */}
      <div className="appHeader">
        <div className="headerRow">
          <div className="headerLeft">
            <button
              type="button"
              className="spOnly iconBtn"
              onPointerDown={(e) => { e.preventDefault(); setSpThreadsOpen(true); }}
              onTouchStart={(e) => { e.preventDefault(); setSpThreadsOpen(true); }}
              aria-label="スレッドを開く"
            >
              ☰
            </button>
          </div>

          <div className="headerCenter">
            <div className={yuji.className} style={{ fontSize: 30, letterSpacing: "0.12em", fontWeight: 400, lineHeight: 1, whiteSpace: "nowrap" }}>
              さじかげん 🍚🥄
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#666", whiteSpace: "nowrap" }}>
              税務相談 ～あなたの欲しい ちょうどいい～
            </div>
          </div>

          <div className="headerRight">
            <div className="pcOnly headerBtns">
              <Link href="/settings/billing" style={LINK_BTN}>プラン変更</Link>
              <a href={CONTACT_URL} style={LINK_BTN} target={CONTACT_URL.startsWith("http") ? "_blank" : undefined} rel="noreferrer">
                お問い合わせ
              </a>
              <button type="button" onPointerDown={(e) => { e.preventDefault(); doLogout(); }} onTouchStart={(e) => { e.preventDefault(); doLogout(); }} style={BTN}>
                ログアウト
              </button>
            </div>

            <button
              type="button"
              className="spOnly iconBtn"
              onPointerDown={(e) => { e.preventDefault(); setSpMenuOpen(true); }}
              onTouchStart={(e) => { e.preventDefault(); setSpMenuOpen(true); }}
              aria-label="メニューを開く"
            >
              ⋯
            </button>
          </div>
        </div>

        <div className="badgeRow">
          <div className="badgeBox">
            <div className="badgeText" style={{ fontWeight: 800 }}>{badge || "プラン: (loading)"}</div>
            <button
              type="button"
              onPointerDown={(e) => { e.preventDefault(); refreshStatus(); }}
              onTouchStart={(e) => { e.preventDefault(); refreshStatus(); }}
              style={{ ...BTN, minWidth: 78 }}
            >
              更新
            </button>
          </div>
        </div>

        {errMsg && <div style={{ marginTop: 8, color: "#b00020", fontSize: 13 }}>{errMsg}</div>}
      </div>

      {/* ===== Body ===== */}
      <div className="appBody">
        <div className="shell">
          {/* PC/Tablet: 左スレッド（畳める） */}
          <div className={`threadCol pcOnly ${sidebarMode === "collapsed" ? "collapsed" : ""}`}>
            <div style={{ padding: 12, display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #eee" }}>
              <div style={{ fontWeight: 900 }}>スレッド</div>
              <button type="button" onPointerDown={(e) => { e.preventDefault(); newThread(); }} onTouchStart={(e) => { e.preventDefault(); newThread(); }} style={BTN}>
                新規
              </button>
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

          {/* 右：チャット本体 */}
          <div className="chatCol">
            <div className="chatTopBar">
              <div className="chatTopLeft">
                <button
                  type="button"
                  className="pcOnly iconBtnSmall"
                  onPointerDown={(e) => { e.preventDefault(); setSidebarMode((p) => (p === "open" ? "collapsed" : "open")); }}
                  onTouchStart={(e) => { e.preventDefault(); setSidebarMode((p) => (p === "open" ? "collapsed" : "open")); }}
                  aria-label="スレッドサイドバー切替"
                  title="スレッド"
                >
                  ☰
                </button>

                                <div className="titleWrap2">
                  <div className="chatTitle2">{activeTitle}</div>
                  <button
                    type="button"
                    className="hintLink"
                    onPointerDown={(e) => { e.preventDefault(); setChatSettingsOpen(true); }}
                    onTouchStart={(e) => { e.preventDefault(); setChatSettingsOpen(true); }}
                  >
                    口調選択/新規スレッド→
                  </button>
                </div>
              </div>

              <div className="chatTopRight">
                <button
                  type="button"
                  className="iconBtnSmall"
                  onPointerDown={(e) => { e.preventDefault(); setChatSettingsOpen(true); }}
                  onTouchStart={(e) => { e.preventDefault(); setChatSettingsOpen(true); }}
                  aria-label="チャット設定"
                  title="設定"
                >
                  ⚙︎
                </button>
              </div>
            </div>

            <div
              ref={msgsRef}
              onScroll={() => {
                const el = msgsRef.current;
                if (!el) return;
                shouldAutoScrollRef.current = isNearBottom(el);
              }}
              className="chatArea"
            >
              {messages.map((m, idx) => {
                const role = normalizeRole((m as any).role);
                const isUser = role === "user";
                const raw = String(m.content ?? "");
                const content = isUser ? raw : stripCatchphraseIfThreePatterns(raw);

                return (
                  <div key={m.id ?? idx} style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start", margin: "10px 0" }}>
                    <div
                      style={{
                        maxWidth: "86%",
                        padding: "10px 12px",
                        borderRadius: 12,
                        border: "1px solid #e5e5e5",
                        background: isUser ? "#eef5ff" : "#fff",
                      }}
                    >
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

            {/* 入力欄（注意文言は下へ） */}
            <div className="chatInputWrap">
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
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
                    whiteSpace: "nowrap",
                  }}
                >
                  送信
                </button>
              </div>

              <div className="disclaimerBottom">
                ※ AIの回答は参考情報です。最終判断はご自身でお願いします。
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ===== SP: スレッド（全画面オーバーレイ） ===== */}
      {spThreadsOpen && (
        <div className="overlay" role="dialog" aria-modal="true">
          <div className="overlaySheet">
            <div className="overlayTop">
              <div style={{ fontWeight: 900 }}>スレッド</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" style={BTN} onPointerDown={(e) => { e.preventDefault(); newThread(); }} onTouchStart={(e) => { e.preventDefault(); newThread(); }}>
                  新規
                </button>
                <button type="button" style={BTN} onPointerDown={(e) => { e.preventDefault(); setSpThreadsOpen(false); }} onTouchStart={(e) => { e.preventDefault(); setSpThreadsOpen(false); }}>
                  閉じる
                </button>
              </div>
            </div>

            <div style={{ padding: 10, overflowY: "auto", flex: 1, background: "#fafafa" }}>
              {threads.map((t) => {
                const active = t.id === activeConversationId;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      setActiveConversationId(t.id);
                      saveLocal("chat:activeConversationId", t.id);
                      setSpThreadsOpen(false);
                    }}
                    onTouchStart={(e) => {
                      e.preventDefault();
                      setActiveConversationId(t.id);
                      saveLocal("chat:activeConversationId", t.id);
                      setSpThreadsOpen(false);
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
                    <div style={{ fontWeight: 900, marginBottom: 6 }}>{t.title}</div>
                    <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>
                      {toJstLabel(t.createdAt)} {toHm(t.createdAt)}
                    </div>
                    <div style={{ fontSize: 12, color: t.preview ? "#333" : "#999" }}>{t.preview || "(プレビューなし)"}</div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ===== SP: 右上メニュー（BottomSheet） ===== */}
      {spMenuOpen && (
        <div className="overlay" role="dialog" aria-modal="true" onPointerDown={() => setSpMenuOpen(false)}>
          <div className="menuSheet" onPointerDown={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 12, borderBottom: "1px solid #eee" }}>
              <div style={{ fontWeight: 900 }}>メニュー</div>
              <button type="button" style={BTN} onPointerDown={(e) => { e.preventDefault(); setSpMenuOpen(false); }} onTouchStart={(e) => { e.preventDefault(); setSpMenuOpen(false); }}>
                閉じる
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12 }}>
              <Link href="/settings/billing" style={{ ...LINK_BTN, width: "100%" }} onClick={() => setSpMenuOpen(false)}>
                プラン変更
              </Link>
              <button type="button" style={{ ...BTN, width: "100%" }} onPointerDown={(e) => { e.preventDefault(); setSpMenuOpen(false); openUrl(CONTACT_URL); }} onTouchStart={(e) => { e.preventDefault(); setSpMenuOpen(false); openUrl(CONTACT_URL); }}>
                お問い合わせ
              </button>
              <button type="button" style={{ ...BTN, width: "100%" }} onPointerDown={(e) => { e.preventDefault(); setSpMenuOpen(false); doLogout(); }} onTouchStart={(e) => { e.preventDefault(); setSpMenuOpen(false); doLogout(); }}>
                ログアウト
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== Chat設定（⚙︎） ===== */}
      {chatSettingsOpen && (
        <div className="overlay" role="dialog" aria-modal="true" onPointerDown={() => setChatSettingsOpen(false)}>
          <div className="menuSheet" onPointerDown={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 12, borderBottom: "1px solid #eee" }}>
              <div style={{ fontWeight: 900 }}>チャット設定</div>
              <button type="button" style={BTN} onPointerDown={(e) => { e.preventDefault(); setChatSettingsOpen(false); }} onTouchStart={(e) => { e.preventDefault(); setChatSettingsOpen(false); }}>
                閉じる
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: 12 }}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <button type="button" style={BTN} onPointerDown={(e) => { e.preventDefault(); setRecommendedMode(); }} onTouchStart={(e) => { e.preventDefault(); setRecommendedMode(); }}>
                  おすすめに戻す（標準語×参謀）
                </button>

                <button type="button" style={BTN} onPointerDown={(e) => { e.preventDefault(); newThread(); }} onTouchStart={(e) => { e.preventDefault(); newThread(); }}>
                  新規スレッド
                </button>

                <button
                  type="button"
                  style={{ ...BTN, opacity: canRename ? 1 : 0.5, cursor: canRename ? "pointer" : "not-allowed" }}
                  onPointerDown={(e) => { e.preventDefault(); if (canRename) renameThread(); }}
                  onTouchStart={(e) => { e.preventDefault(); if (canRename) renameThread(); }}
                  aria-disabled={!canRename}
                >
                  タイトル変更
                </button>

                <button
                  type="button"
                  className="pcOnly"
                  style={BTN}
                  onPointerDown={(e) => { e.preventDefault(); setSidebarMode((p) => (p === "open" ? "collapsed" : "open")); }}
                  onTouchStart={(e) => { e.preventDefault(); setSidebarMode((p) => (p === "open" ? "collapsed" : "open")); }}
                >
                  スレッド欄：{sidebarMode === "open" ? "表示中" : "非表示"}（切替）
                </button>
              </div>

              <div style={{ borderTop: "1px solid #eee", paddingTop: 12 }}>
                <div style={{ fontWeight: 900, marginBottom: 8 }}>口調</div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button type="button" style={toggleBtn(dialect === "standard")} onPointerDown={(e) => { e.preventDefault(); setDialect("standard"); }} onTouchStart={(e) => { e.preventDefault(); setDialect("standard"); }}>
                    標準語
                  </button>
                  <button type="button" style={toggleBtn(dialect === "kansai")} onPointerDown={(e) => { e.preventDefault(); setDialect("kansai"); }} onTouchStart={(e) => { e.preventDefault(); setDialect("kansai"); }}>
                    関西弁
                  </button>
                </div>
              </div>

              <div style={{ borderTop: "1px solid #eee", paddingTop: 12 }}>
                <div style={{ fontWeight: 900, marginBottom: 8 }}>モード</div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button type="button" style={toggleBtn(stance === "sanbo")} onPointerDown={(e) => { e.preventDefault(); setStance("sanbo"); }} onTouchStart={(e) => { e.preventDefault(); setStance("sanbo"); }}>
                    参謀
                  </button>
                  <button type="button" style={toggleBtn(stance === "zubatto")} onPointerDown={(e) => { e.preventDefault(); setStance("zubatto"); }} onTouchStart={(e) => { e.preventDefault(); setStance("zubatto"); }}>
                    ズバっと
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ===== AI野口プロフィール ===== */}
      {aiProfileOpen && (
        <div className="overlay" role="dialog" aria-modal="true" onPointerDown={() => setAiProfileOpen(false)}>
          <div className="profileSheet" onPointerDown={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 12, borderBottom: "1px solid #eee" }}>
              <div style={{ fontWeight: 900 }}>AI野口</div>
              <button type="button" style={BTN} onPointerDown={(e) => { e.preventDefault(); setAiProfileOpen(false); }} onTouchStart={(e) => { e.preventDefault(); setAiProfileOpen(false); }}>
                閉じる
              </button>
            </div>

            <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
              <img
                src={AI_AVATAR_URL}
                alt="AI野口"
                style={{ width: 180, height: 180, borderRadius: "999px", objectFit: "cover", border: "1px solid #e5e5e5" }}
              />
              <div style={{ textAlign: "center" }}>
                <div style={{ fontWeight: 900, fontSize: 18 }}>AI野口（税理士）</div>
                <div style={{ color: "#666", fontSize: 13, marginTop: 4 }}>税理士法人GLADZ 代表税理士 野口のAI</div>
              </div>

              <button
                type="button"
                style={{ ...BTN, width: "100%", padding: "12px 12px" }}
                onPointerDown={(e) => { e.preventDefault(); openUrl(CONTACT_URL); }}
                onTouchStart={(e) => { e.preventDefault(); openUrl(CONTACT_URL); }}
              >
                お問い合わせ（AI野口に伝える）
              </button>
            </div>
          </div>
        </div>
      )}

      <style jsx global>{`
        .appRoot {
          height: 100dvh;
          height: 100vh;
          display: flex;
          flex-direction: column;
          background: #fff;
          overflow: hidden;
        }

        .appHeader {
          padding: 10px 16px;
          position: relative;
          z-index: 30;
          pointer-events: auto;
          flex: 0 0 auto;
        }

        .headerRow {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .headerLeft, .headerRight {
          flex: 1;
          display: flex;
          align-items: center;
        }
        .headerLeft { justify-content: flex-start; }
        .headerRight { justify-content: flex-end; }

        .headerCenter {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 6px;
          text-align: center;
          min-width: 0;
        }

        .headerBtns {
          display: flex;
          gap: 10px;
          align-items: center;
        }

        .iconBtn {
          padding: 8px 12px;
          border-radius: 10px;
          border: 1px solid #ddd;
          background: #fff;
          cursor: pointer;
          white-space: nowrap;
        }
        .iconBtnSmall {
          padding: 8px 10px;
          border-radius: 10px;
          border: 1px solid #ddd;
          background: #fff;
          cursor: pointer;
          white-space: nowrap;
        }

        .badgeRow {
          margin-top: 10px;
          display: flex;
          justify-content: center;
        }
        .badgeBox {
          width: min(1400px, 100%);
          border: 1px solid #ddd;
          border-radius: 12px;
          padding: 10px 12px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
        }
        .badgeText { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

        .appBody {
          flex: 1 1 auto;
          min-height: 0;
          display: flex;
          justify-content: center;
          padding: 0 16px 16px;
        }

        .shell {
          width: min(1400px, 100%);
          border: 1px solid #ddd;
          border-radius: 12px;
          display: flex;
          overflow: hidden;
          min-height: 0;
          background: #fff;
        }

        .threadCol {
          width: 330px;
          border-right: 1px solid #eee;
          display: flex;
          flex-direction: column;
          min-height: 0;
        }
        .threadCol.collapsed { display: none; }

        .chatCol {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-height: 0;
          background: #fff;
        }

        .chatTopBar {
          padding: 10px 12px;
          border-bottom: 1px solid #eee;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          background: #fff;
          position: relative;
          z-index: 20;
          flex: 0 0 auto;
        }

        .chatTopLeft {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
          flex: 1;
        }

        .titleWrap2 {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 4px;
          flex: 1;
        }

        .chatTitle2 {
          font-weight: 900;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .hintLink {
          border: none;
          background: transparent;
          padding: 0;
          text-align: left;
          color: #666;
          font-size: 12px;
          cursor: pointer;
          width: fit-content;
        }

        .chatTopRight { display: flex; gap: 8px; align-items: center; flex: 0 0 auto; }

        .chatArea {
          flex: 1 1 auto;
          min-height: 0;
          overflow-y: auto;
          padding: 12px 14px;
          background: #fff;
        }

        .chatInputWrap {
          flex: 0 0 auto;
          padding: 10px 12px 12px;
          border-top: 1px solid #eee;
          background: #fff;
          position: sticky;
          bottom: 0;
        }

        .disclaimerBottom {
          padding-top: 10px;
          font-size: 12px;
          color: #777;
        }

        .pcOnly { display: flex; }
        .spOnly { display: none; }

        @media (max-width: 760px) {
          .pcOnly { display: none !important; }
          .spOnly { display: inline-flex !important; }

          .appHeader { padding: 10px 12px; }
          .appBody { padding: 0 12px 12px; }

          .headerCenter > div:last-child { font-size: 12px !important; }
        }

        .overlay {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.35);
          z-index: 200;
          display: flex;
          align-items: flex-end;
          justify-content: center;
        }

        .menuSheet {
          width: min(560px, 100%);
          background: #fff;
          border-top-left-radius: 16px;
          border-top-right-radius: 16px;
          border: 1px solid #ddd;
          border-bottom: none;
        }

        .overlaySheet {
          width: min(760px, 100%);
          height: min(90dvh, 720px);
          height: min(90vh, 720px);
          background: #fff;
          border-radius: 16px;
          border: 1px solid #ddd;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          margin: 10px;
        }

        .overlayTop {
          padding: 12px;
          border-bottom: 1px solid #eee;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          background: #fff;
          flex: 0 0 auto;
        }

        .profileSheet {
          width: min(560px, 100%);
          background: #fff;
          border-radius: 16px;
          border: 1px solid #ddd;
          margin: 12px;
          overflow: hidden;
        }

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
