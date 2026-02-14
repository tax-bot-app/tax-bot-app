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

type ChatRes =
  | {
      ok: true;
      plan: string;
      used_talks: number | null;
      limit_talks: number | null;
      message: string;
      conversation_id: string | null;

      guardrail_block?: boolean;
      guardrail_action?: "block" | "inject" | "none";
    }
  | {
      ok: false;
      error: string;
      used_talks?: number | null;
      limit_talks?: number | null;
      conversation_id?: string | null;

      guardrail_block?: boolean;
      guardrail_action?: "block" | "inject" | "none";
    };

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

/**
 * 旧フォーマットの余計な締め文を削る保険（残しておく）
 */
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

function isHeadingLine(line: string): boolean {
  const raw = line.trim();
  if (!raw) return false;

  // markdown headings
  const t = raw.replace(/^#{1,6}\s*/, "").trim();

  // bracketed heading like 【結論】
  const t2 = t.replace(/^【/, "").replace(/】$/, "").trim();

  // support "結論：" / "結論:" / "結論 -"
  const key = t2.replace(/[：:：\-–—].*$/, "").trim();

  if (key === "結論" || key === "要点" || key === "注意") return true;

  // 旧絵文字見出しも「見出し扱い」に寄せる（背景ベタ塗りはしない）
  if (
    t2.startsWith("🥄") ||
    t2.startsWith("🧂") ||
    t2.startsWith("🍚") ||
    t2.startsWith("🧂🥄") ||
    t2.startsWith("🍚🥄")
  ) {
    return true;
  }

  return false;
}

function lineStyle(line: string): React.CSSProperties {
  const t = line.trim();

  // 見出し：薄い下線（ChatGPT寄せ）
  if (isHeadingLine(line)) {
    return {
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
      lineHeight: 1.55,
      fontWeight: 800,
      color: "#111",
      paddingBottom: 8,
      marginTop: 6,
      borderBottom: "1px solid #e5e7eb", // 薄い下線
    };
  }

  return {
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    lineHeight: 1.6,
    color: "#111",
  };
}

const WELCOME_SEEN_KEY = "chat:welcomeSeen:v1";

/**
 * ※文言はユーザーが後で整理する前提：仮のプレースホルダ
 */
const WELCOME_MESSAGE = [
  "はじめまして、AI野口です。",
  "税務は「攻め」「守り」「ちょうど良いライン」で整理します。",
  "",
  "口調は設定から固定できます（関西弁 / ズバっと など）。",
  "お好みに応じて選んでください。",
  "",
  "まずは気になることを、そのまま書いてください。",
].join("\n");

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
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

  // 初期：標準語×参謀（保存があれば尊重）
  const [dialect, setDialect] = useState<Dialect>(() =>
    loadLocal("chat:dialect") === "kansai" ? "kansai" : "standard"
  );
  const [stance, setStance] = useState<Stance>(() =>
    loadLocal("chat:stance") === "zubatto" ? "zubatto" : "sanbo"
  );

  const [threads, setThreads] = useState<ThreadItem[]>([]);
  const [threadsLoaded, setThreadsLoaded] = useState(false);

  const [activeConversationId, setActiveConversationId] = useState<string | null>(() => {
    const v = loadLocal("chat:activeConversationId");
    return v && isUuid(v) ? v : null;
  });

  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [input, setInput] = useState("");

  // UI
  const [spThreadsOpen, setSpThreadsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const [composerOpen, setComposerOpen] = useState(false);
  const [composerText, setComposerText] = useState("");

  // AI野口アクション（タップでフルスクリーン遷移）
  const [aiActionOpen, setAiActionOpen] = useState(false);
  const [aiActionTarget, setAiActionTarget] = useState<{ messageId: string; text: string } | null>(null);

  // PC/Tablet: サイドバー畳む
  const [sidebarMode, setSidebarMode] = useState<"open" | "collapsed">(() =>
    loadLocal("chat:sidebar") === "collapsed" ? "collapsed" : "open"
  );

  // アバター表示保険（画像が出なくても丸が出る）
  const [aiAvatarOk, setAiAvatarOk] = useState(true);

  const msgsRef = useRef<HTMLDivElement | null>(null);
  const redirectingRef = useRef(false);
  const shouldAutoScrollRef = useRef(true);

  const threadTouchRef = useRef<{ x: number; y: number; moved: boolean; id: string | null }>({
    x: 0,
    y: 0,
    moved: false,
    id: null,
  });

  const CONTACT_URL = process.env.NEXT_PUBLIC_CONTACT_URL || "mailto:support@example.com";

  // public/ai-noguchi.jpg
  const AI_AVATAR_URL = "/ai-noguchi.jpg";

  const BTN: CSSProperties = {
    padding: "8px 12px",
    borderRadius: 12,
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

  const clearChatUiState = () => {
    setThreads([]);
    setMessages([]);
    setActiveConversationId(null);
    try {
      localStorage.removeItem("chat:activeConversationId");
    } catch {}
  };

  const scrollBottom = () => {
    const el = msgsRef.current;
    if (!el) return;
    // heavy scroll fix（今の実装のまま）
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
    } finally {
      setThreadsLoaded(true);
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
    setComposerText("");
    setComposerOpen(false);
    setSpThreadsOpen(false);
    setMenuOpen(false);
  };

  const selectThread = (id: string) => {
    setActiveConversationId(id);
    saveLocal("chat:activeConversationId", id);
    setSpThreadsOpen(false);
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
      setMenuOpen(false);
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

  const badge = (() => {
    if (!limitTalks) return `プラン: ${plan}`;
    const used = usedTalks ?? 0;
    const left = Math.max(0, limitTalks - used);
    return `プラン: ${plan} / 残り ${left} 回（${used}/${limitTalks}）`;
  })();

  const openUrl = (url: string) => {
    if (url.startsWith("http")) window.open(url, "_blank", "noreferrer");
    else window.location.href = url;
  };

  const doLogout = async () => {
    await supabase.auth.signOut().catch(() => null);
    clearChatUiState();
    router.replace("/login");
  };

  const openComposer = () => {
    if (!canSend) return;
    setComposerText(input || "");
    setComposerOpen(true);
  };

  const closeComposer = () => {
    setComposerOpen(false);
  };

  const openAiActionsFor = (messageId: string, text: string) => {
    setAiActionTarget({ messageId, text });
    setAiActionOpen(true);
  };

  const doCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      window.alert("コピーしました。");
    } catch {
      window.alert("コピーに失敗しました。");
    }
  };

  const doShare = async (text: string) => {
    const nav: any = navigator as any;
    try {
      if (nav?.share) {
        await nav.share({ text });
        return;
      }
    } catch {
      // ignore and fallback
    }
    // fallback: copy
    await doCopy(text);
  };

  const typeOutAssistant = async (assistantId: string, fullText: string) => {
    const full = String(fullText ?? "");
    if (!full) return;

    // コードブロックがあると刻むと読みにくいので一括
    if (full.includes("```")) {
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: full } : m)));
      if (shouldAutoScrollRef.current) scrollBottom();
      return;
    }

    const chars = Array.from(full);
    const total = chars.length;

    // ChatGPT体感寄せ：基準 30 chars/sec、長文は少し加速、冒頭は少し速い
    let cps = 30;
    if (total >= 800) cps *= 1.15;
    if (total >= 1500) cps *= 1.25;

    const basePerChar = 1000 / cps;
    const boostChars = 60;
    const boostFactor = 1.35;

    let idx = 0;
    let built = "";

    while (idx < total) {
      // chunk: 日本語は2文字、句読点/改行は1文字（間が作れる）
      const next = chars[idx] ?? "";
      let chunkLen = 2;

      if (next === "\n") chunkLen = 1;
      if ("。！？!?".includes(next)) chunkLen = 1;

      // ちょいランダムっぽい揺れ（固定等速の機械感を消す）
      if (chunkLen === 2 && Math.random() < 0.08) chunkLen = 3;

      const chunk = chars.slice(idx, idx + chunkLen).join("");
      idx += chunkLen;
      built += chunk;

      setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: built } : m)));

      if (shouldAutoScrollRef.current) scrollBottom();

      // delay計算
      const isBoost = built.length <= boostChars;
      const speed = isBoost ? cps * boostFactor : cps;
      const perChar = 1000 / speed;
      let delay = Math.ceil(perChar * chunk.length);

      // 句読点/改行で小休止（“考えてる感”）
      const last = chunk.slice(-1);
      if ("。！？!?".includes(last)) delay += 140;
      if (last === "\n") delay += 120;

      // セクション見出しの直後（結論/要点/注意など）で少し間を空ける
      if (last === "\n") {
        const lines = built.split("\n");
        const prevLine = (lines[lines.length - 2] ?? "").trim();
        if (isHeadingLine(prevLine)) delay += 220;
      }

      await sleep(delay);
    }
  };

  const sendMessage = async (overrideText?: string) => {
    const text = String(overrideText ?? input).trim();
    if (!text) return;

    setErrMsg(null);
    setLoading(true);
    setThinking(true);

    // どっちから送っても、入力値はクリア
    setInput("");
    setComposerText("");
    setComposerOpen(false);

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

      const isGuardrailBlock = Boolean((json as any)?.guardrail_block);

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
      await typeOutAssistant(assistantId, full);

      setPlan(json.plan);
      if (json.used_talks !== null && json.used_talks !== undefined) setUsedTalks(json.used_talks);
      if (json.limit_talks !== null && json.limit_talks !== undefined) setLimitTalks(json.limit_talks);

      const convId = json.conversation_id && isUuid(json.conversation_id) ? json.conversation_id : null;

      if (convId && !activeConversationId) {
        setActiveConversationId(convId);
        saveLocal("chat:activeConversationId", convId);
        setMessages((prev) =>
          prev.map((m) => (m.conversation_id === "temp" ? { ...m, conversation_id: convId } : m))
        );
      }

      const effectiveConvId = convId || activeConversationId;

      if (isGuardrailBlock && !effectiveConvId) {
        // DB再読込すると表示が消える可能性があるのでスキップ
        return;
      }

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

  // 初回だけ保存（無い人だけ）
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

  // 小さめPC/タブレットは初回だけ自動で畳む（保存が無い人だけ）
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

  // ✅ 初回起動ウェルカム（ユーザー単位で1回だけ：localStorage）
  useEffect(() => {
    if (!threadsLoaded) return;
    if (activeConversationId) return;
    if (threads.length > 0) return;

    const seen = loadLocal(WELCOME_SEEN_KEY);
    if (seen === "1") return;

    if (messages.length === 0) {
      const welcome: MessageRow = {
        id: "welcome",
        conversation_id: "welcome",
        role: "assistant",
        content: WELCOME_MESSAGE,
        created_at: new Date().toISOString(),
      };
      setMessages([welcome]);
    }
    saveLocal(WELCOME_SEEN_KEY, "1");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadsLoaded, activeConversationId, threads.length]);

  const canRename = Boolean(activeConversationId);

  return (
    <div className="appRoot">
      {/* ===== Body ===== */}
      <div className="appBody">
        <div className="shell">
          {/* PC/Tablet: 左スレッド（畳める） */}
          <div className={`threadCol pcOnly ${sidebarMode === "collapsed" ? "collapsed" : ""}`}>
            <div className="threadColTop">
              <div style={{ fontWeight: 900 }}>スレッド</div>
              <button
                type="button"
                onPointerDown={(e) => {
                  e.preventDefault();
                  newThread();
                }}
                onTouchStart={(e) => {
                  e.preventDefault();
                  newThread();
                }}
                style={BTN}
              >
                新規
              </button>
            </div>

            <div className="threadList">
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
                    }}
                    onTouchStart={(e) => {
                      e.preventDefault();
                      setActiveConversationId(t.id);
                      saveLocal("chat:activeConversationId", t.id);
                    }}
                    className={`threadItem ${active ? "active" : ""}`}
                  >
                    <div className="threadTitle">{t.title}</div>
                    <div className="threadMeta">
                      {toJstLabel(t.createdAt)} {toHm(t.createdAt)}
                    </div>
                    <div className="threadPreview">{t.preview || "(プレビューなし)"}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 右：チャット本体 */}
          <div className="chatCol">
            {/* ✅ 1行ヘッダー（ChatGPT寄せ） */}
            <div className="topBar">
              <div className="topLeft">
                {/* SP: ←でスレッド */}
                <button
                  type="button"
                  className="spOnly topIconBtn"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    setSpThreadsOpen(true);
                  }}
                  onTouchStart={(e) => {
                    e.preventDefault();
                    setSpThreadsOpen(true);
                  }}
                  aria-label="スレッドを開く"
                  title="スレッド"
                >
                  ←
                </button>

                {/* PC: ☰でサイドバー切替 */}
                <button
                  type="button"
                  className="pcOnly topIconBtn"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    setSidebarMode((p) => (p === "open" ? "collapsed" : "open"));
                  }}
                  onTouchStart={(e) => {
                    e.preventDefault();
                    setSidebarMode((p) => (p === "open" ? "collapsed" : "open"));
                  }}
                  aria-label="スレッドサイドバー切替"
                  title="スレッド"
                >
                  ☰
                </button>

                <div className={`appTitle ${yuji.className}`} title="さじかげん">
                  さじかげん
                </div>
              </div>

              <div className="topRight">
                <button
                  type="button"
                  className="topIconBtn"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    newThread();
                  }}
                  onTouchStart={(e) => {
                    e.preventDefault();
                    newThread();
                  }}
                  aria-label="新規スレッド"
                  title="新規スレッド"
                >
                  ＋
                </button>

                <button
                  type="button"
                  className="topIconBtn"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    setMenuOpen(true);
                  }}
                  onTouchStart={(e) => {
                    e.preventDefault();
                    setMenuOpen(true);
                  }}
                  aria-label="メニュー"
                  title="メニュー"
                >
                  ⋯
                </button>
              </div>
            </div>

            {errMsg && <div className="errorLine">{errMsg}</div>}

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

                if (isUser) {
                  return (
                    <div key={m.id ?? idx} className="msgRow userRow">
                      <div className="userBubble">
                        <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.6 }}>
                          {content}
                        </div>
                        <div className="msgTime">{toHm(m.created_at)}</div>
                      </div>
                    </div>
                  );
                }

                // assistant
                return (
                  <div key={m.id ?? idx} className="msgRow asstRow">
                    <div className="asstAvatar">
                      {aiAvatarOk ? (
                        <img
                          src={AI_AVATAR_URL}
                          alt="AI野口"
                          onClick={() => openAiActionsFor(m.id, content)}
                          onError={() => setAiAvatarOk(false)}
                          style={{
                            width: 26,
                            height: 26,
                            display: "block",
                            borderRadius: 999,
                            objectFit: "cover",
                            border: "1px solid #e5e5e5",
                            cursor: "pointer",
                          }}
                        />
                      ) : (
                        <div
                          onClick={() => openAiActionsFor(m.id, content)}
                          style={{
                            width: 26,
                            height: 26,
                            borderRadius: 999,
                            border: "1px solid #e5e5e5",
                            background: "#fff",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 12,
                            cursor: "pointer",
                          }}
                          aria-label="AI野口"
                          title="AI野口"
                        >
                          🤖
                        </div>
                      )}
                    </div>

                    <div className="asstBody">
                      <div className="asstNameLine">
                        <button
                          type="button"
                          onPointerDown={(e) => {
                            e.preventDefault();
                            openAiActionsFor(m.id, content);
                          }}
                          onTouchStart={(e) => {
                            e.preventDefault();
                            openAiActionsFor(m.id, content);
                          }}
                          className="asstNameBtn"
                        >
                          AI野口（税理士）
                        </button>
                        <span className="asstTime">{toHm(m.created_at)}</span>
                      </div>

                      <div className="asstText">
                        {content
                          .replace(/\r\n/g, "\n")
                          .split("\n")
                          .map((line, i) => {
                            if (!line.trim()) return <div key={i} style={{ height: 6 }} />;
                            return (
                              <div key={i} style={lineStyle(line)}>
                                {renderBoldInline(line)}
                              </div>
                            );
                          })}
                      </div>

                      {/* 生成中のカーソルっぽさ（空の時だけ） */}
                      {thinking && String(m.content ?? "").length === 0 && (
                        <div className="typingDots" aria-hidden="true">
                          <span className="dots">...</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 入力欄（PCはその場、SPは押してComposerへ） */}
            <div className="chatInputWrap">
              {/* PC */}
              <div className="pcOnly" style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (canSend) sendMessage();
                    }
                  }}
                  placeholder={loading ? "回答中…" : "相談内容を入力（Enterで送信）"}
                  style={{ flex: 1, padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd" }}
                  disabled={!canSend}
                />

                {/* ✅ 送信は矢印のみ */}
                <button
                  type="button"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    if (canSend) sendMessage();
                  }}
                  onTouchStart={(e) => {
                    e.preventDefault();
                    if (canSend) sendMessage();
                  }}
                  disabled={!canSend}
                  className="sendArrowBtn"
                  aria-label="送信"
                  title="送信"
                >
                  ↗︎
                </button>
              </div>

              {/* SP */}
              <button
                type="button"
                className="spOnly inputDock"
                onPointerDown={(e) => {
                  e.preventDefault();
                  openComposer();
                }}
                onTouchStart={(e) => {
                  e.preventDefault();
                  openComposer();
                }}
                disabled={!canSend}
                aria-label="入力を開く"
                title="入力"
              >
                <span className="dockPlaceholder">{loading ? "回答中…" : "相談内容を入力"}</span>
                <span className="dockArrow">↗︎</span>
              </button>

              <div className="disclaimerBottom">※ AIの回答は参考情報です。最終判断はご自身でお願いします。</div>
            </div>
          </div>
        </div>
      </div>

      {/* ===== SP: スレッド（フルスクリーン） ===== */}
      {spThreadsOpen && (
        <div className="overlay overlayWhite" role="dialog" aria-modal="true">
          <div className="fullSheet">
            <div className="fullTopBar">
              <button
                type="button"
                className="topIconBtn"
                onPointerDown={(e) => {
                  e.preventDefault();
                  setSpThreadsOpen(false);
                }}
                onTouchStart={(e) => {
                  e.preventDefault();
                  setSpThreadsOpen(false);
                }}
                aria-label="戻る"
                title="戻る"
              >
                ←
              </button>
              <div style={{ fontWeight: 900 }}>スレッド</div>
              <button
                type="button"
                className="topIconBtn"
                onPointerDown={(e) => {
                  e.preventDefault();
                  newThread();
                }}
                onTouchStart={(e) => {
                  e.preventDefault();
                  newThread();
                }}
                aria-label="新規"
                title="新規"
              >
                ＋
              </button>
            </div>

            <div className="fullList">
              {threads.map((t) => {
                const active = t.id === activeConversationId;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onPointerDown={(e) => {
                      const pt = (e as any).pointerType;
                      if (pt && pt !== "touch") return;

                      threadTouchRef.current = {
                        x: e.clientX,
                        y: e.clientY,
                        moved: false,
                        id: t.id,
                      };
                    }}
                    onPointerMove={(e) => {
                      const pt = (e as any).pointerType;
                      if (pt && pt !== "touch") return;

                      const dx = Math.abs(e.clientX - threadTouchRef.current.x);
                      const dy = Math.abs(e.clientY - threadTouchRef.current.y);
                      if (dx > 10 || dy > 10) threadTouchRef.current.moved = true;
                    }}
                    onPointerUp={(e) => {
                      const pt = (e as any).pointerType;
                      if (pt && pt !== "touch") return;

                      const st = threadTouchRef.current;
                      if (!st.moved && st.id) {
                        e.preventDefault();
                        selectThread(st.id);
                      }
                      threadTouchRef.current.id = null;
                    }}
                    onClick={(e) => {
                      e.preventDefault();
                      selectThread(t.id);
                    }}
                    className={`threadItemFull ${active ? "active" : ""}`}
                  >
                    <div className="threadTitle">{t.title}</div>
                    <div className="threadMeta">
                      {toJstLabel(t.createdAt)} {toHm(t.createdAt)}
                    </div>
                    <div className="threadPreview">{t.preview || "(プレビューなし)"}</div>
                  </button>
                );
              })}
              {threads.length === 0 && (
                <div style={{ padding: 16, color: "#666", fontSize: 13 }}>スレッドがありません。右上の「＋」で作れます。</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ===== メニュー（…） ===== */}
      {menuOpen && (
        <div className="overlay" role="dialog" aria-modal="true" onPointerDown={() => setMenuOpen(false)}>
          <div className="menuSheet" onPointerDown={(e) => e.stopPropagation()}>
            <div className="sheetTop">
              <div style={{ fontWeight: 900 }}>メニュー</div>
              <button
                type="button"
                style={BTN}
                onPointerDown={(e) => {
                  e.preventDefault();
                  setMenuOpen(false);
                }}
                onTouchStart={(e) => {
                  e.preventDefault();
                  setMenuOpen(false);
                }}
              >
                閉じる
              </button>
            </div>

            {/* プラン */}
            <div className="sheetSection">
              <div className="sheetLabel">利用状況</div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ fontSize: 12, color: "#333", fontWeight: 800 }}>{badge}</div>
                <button
                  type="button"
                  style={{ ...BTN, minWidth: 78 }}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    refreshStatus();
                  }}
                  onTouchStart={(e) => {
                    e.preventDefault();
                    refreshStatus();
                  }}
                >
                  更新
                </button>
              </div>
            </div>

            {/* スレッド */}
            <div className="sheetSection">
              <div className="sheetLabel">スレッド</div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <button
                  type="button"
                  style={BTN}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    newThread();
                  }}
                  onTouchStart={(e) => {
                    e.preventDefault();
                    newThread();
                  }}
                >
                  新規スレッド
                </button>

                <button
                  type="button"
                  style={{ ...BTN, opacity: canRename ? 1 : 0.5, cursor: canRename ? "pointer" : "not-allowed" }}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    if (canRename) renameThread();
                  }}
                  aria-disabled={!canRename}
                >
                  タイトル変更
                </button>
              </div>
            </div>

            {/* 口調 */}
            <div className="sheetSection">
              <div className="sheetLabel">口調</div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button
                  type="button"
                  style={toggleBtn(dialect === "standard")}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    setDialect("standard");
                  }}
                  onTouchStart={(e) => {
                    e.preventDefault();
                    setDialect("standard");
                  }}
                >
                  標準語
                </button>
                <button
                  type="button"
                  style={toggleBtn(dialect === "kansai")}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    setDialect("kansai");
                  }}
                  onTouchStart={(e) => {
                    e.preventDefault();
                    setDialect("kansai");
                  }}
                >
                  関西弁
                </button>
              </div>
            </div>

            {/* モード */}
            <div className="sheetSection">
              <div className="sheetLabel">モード</div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button
                  type="button"
                  style={toggleBtn(stance === "sanbo")}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    setStance("sanbo");
                  }}
                  onTouchStart={(e) => {
                    e.preventDefault();
                    setStance("sanbo");
                  }}
                >
                  参謀
                </button>
                <button
                  type="button"
                  style={toggleBtn(stance === "zubatto")}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    setStance("zubatto");
                  }}
                  onTouchStart={(e) => {
                    e.preventDefault();
                    setStance("zubatto");
                  }}
                >
                  ズバっと
                </button>
              </div>
            </div>

            {/* 外部 */}
            <div className="sheetSection">
              <div className="sheetLabel">その他</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <Link href="/settings/billing" style={{ ...LINK_BTN, width: "100%" }} onClick={() => setMenuOpen(false)}>
                  プラン変更
                </Link>

                <button
                  type="button"
                  style={{ ...BTN, width: "100%" }}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    setMenuOpen(false);
                    openUrl(CONTACT_URL);
                  }}
                  onTouchStart={(e) => {
                    e.preventDefault();
                    setMenuOpen(false);
                    openUrl(CONTACT_URL);
                  }}
                >
                  お問い合わせ
                </button>

                <button
                  type="button"
                  style={{ ...BTN, width: "100%" }}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    setMenuOpen(false);
                    doLogout();
                  }}
                  onTouchStart={(e) => {
                    e.preventDefault();
                    setMenuOpen(false);
                    doLogout();
                  }}
                >
                  ログアウト
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ===== SP: Composer（フルスクリーン入力） ===== */}
      {composerOpen && (
        <div className="composerOverlay" role="dialog" aria-modal="true">
          <div className="composerTopBar">
            <button
              type="button"
              className="topIconBtn"
              onPointerDown={(e) => {
                e.preventDefault();
                closeComposer();
              }}
              onTouchStart={(e) => {
                e.preventDefault();
                closeComposer();
              }}
              aria-label="戻る"
              title="戻る"
            >
              ←
            </button>

            <div style={{ fontWeight: 900 }}>相談内容</div>

            <button
              type="button"
              className={`topIconBtn ${!canSend || !composerText.trim() ? "disabled" : ""}`}
              onPointerDown={(e) => {
                e.preventDefault();
                if (!canSend) return;
                if (!composerText.trim()) return;
                sendMessage(composerText);
              }}
              onTouchStart={(e) => {
                e.preventDefault();
                if (!canSend) return;
                if (!composerText.trim()) return;
                sendMessage(composerText);
              }}
              aria-label="送信"
              title="送信"
              disabled={!canSend || !composerText.trim()}
            >
              ↗︎
            </button>
          </div>

          <div className="composerBody">
            <textarea
              value={composerText}
              onChange={(e) => setComposerText(e.target.value)}
              placeholder="相談内容を入力してください"
              className="composerTextarea"
              autoFocus
            />
            <div className="composerHint">※ 口調はメニュー（⋯）から固定できます。</div>
            <div className="composerDisclaimer">※ AIの回答は参考情報です。最終判断はご自身でお願いします。</div>
          </div>
        </div>
      )}

      {/* ===== AI野口アクション（フルスクリーン遷移） ===== */}
      {aiActionOpen && (
        <div className="overlay overlayProfile" role="dialog" aria-modal="true">
          <div className="profileSheet" onPointerDown={(e) => e.stopPropagation()}>
            <div className="fullTopBar">
              <div style={{ fontWeight: 900 }}>AI野口</div>
              <button
                type="button"
                style={BTN}
                onPointerDown={(e) => {
                  e.preventDefault();
                  setAiActionOpen(false);
                }}
                onTouchStart={(e) => {
                  e.preventDefault();
                  setAiActionOpen(false);
                }}
              >
                閉じる
              </button>
            </div>

            <div className="profileBody">
              <img
                src={AI_AVATAR_URL}
                alt="AI野口"
                style={{
                  width: "min(160px, 46vw)",
                  height: "min(160px, 46vw)",
                  borderRadius: "999px",
                  objectFit: "cover",
                  border: "1px solid #e5e5e5",
                }}
              />

              <div style={{ textAlign: "center" }}>
                <div style={{ fontWeight: 900, fontSize: 18 }}>AI野口（税理士）</div>
                <div style={{ color: "#666", fontSize: 13, marginTop: 4 }}>税理士法人GLADZ 代表税理士 野口のAI</div>
              </div>

              {aiActionTarget?.text && (
                <div className="answerPreview">
                  <div className="previewLabel">対象の回答</div>
                  <div className="previewText">{aiActionTarget.text}</div>
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
                <button
                  type="button"
                  style={{ ...BTN, width: "100%", padding: "12px 12px" }}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    if (!aiActionTarget?.text) return;
                    doCopy(aiActionTarget.text);
                  }}
                  onTouchStart={(e) => {
                    e.preventDefault();
                    if (!aiActionTarget?.text) return;
                    doCopy(aiActionTarget.text);
                  }}
                >
                  コピー
                </button>

                <button
                  type="button"
                  style={{ ...BTN, width: "100%", padding: "12px 12px" }}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    if (!aiActionTarget?.text) return;
                    doShare(aiActionTarget.text);
                  }}
                  onTouchStart={(e) => {
                    e.preventDefault();
                    if (!aiActionTarget?.text) return;
                    doShare(aiActionTarget.text);
                  }}
                >
                  共有
                </button>

                <button
                  type="button"
                  style={{ ...BTN, width: "100%", padding: "12px 12px" }}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    openUrl(CONTACT_URL);
                  }}
                  onTouchStart={(e) => {
                    e.preventDefault();
                    openUrl(CONTACT_URL);
                  }}
                >
                  不適切な回答を報告 / 問い合わせ
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <style jsx global>{`
        .appRoot {
          height: 100dvh;
          display: flex;
          flex-direction: column;
          background: #fff;
          overflow: hidden;
        }

        .appBody {
          flex: 1 1 auto;
          min-height: 0;
          display: flex;
          justify-content: center;
          padding: 12px;
          box-sizing: border-box;
        }

        .shell {
          width: min(1400px, 100%);
          border: 1px solid #ddd;
          border-radius: 14px;
          display: flex;
          overflow: hidden;
          min-height: 0;
          background: #fff;
        }

        .pcOnly {
          display: flex;
        }
        .spOnly {
          display: none;
        }

        /* ===== Thread Col ===== */
        .threadCol {
          width: 330px;
          border-right: 1px solid #eee;
          display: flex;
          flex-direction: column;
          min-height: 0;
          background: #fff;
        }
        .threadCol.collapsed {
          display: none;
        }

        .threadColTop {
          padding: 12px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-bottom: 1px solid #eee;
        }

        .threadList {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          padding: 10px;
          background: #fafafa;
        }

        .threadItem {
          width: 100%;
          text-align: left;
          padding: 10px;
          margin-bottom: 8px;
          border-radius: 12px;
          border: 1px solid #e5e5e5;
          background: #fff;
          cursor: pointer;
        }
        .threadItem.active {
          border: 2px solid #c7d2fe;
          background: #eef2ff;
        }
        .threadTitle {
          font-weight: 900;
          margin-bottom: 6px;
        }
        .threadMeta {
          font-size: 12px;
          color: #666;
          margin-bottom: 4px;
        }
        .threadPreview {
          font-size: 12px;
          color: #333;
        }

        /* ===== Chat Col ===== */
        .chatCol {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-height: 0;
          background: #fff;
        }

        /* ✅ 1行ヘッダー */
        .topBar {
          padding: calc(10px + env(safe-area-inset-top)) 12px 10px;
          border-bottom: 1px solid #eee;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          background: #fff;
          z-index: 20;
          flex: 0 0 auto;
        }

        .topLeft {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
          flex: 1;
        }

        .appTitle {
          font-size: 18px;
          font-weight: 900;
          letter-spacing: 0.08em;
          line-height: 1;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .topRight {
          display: flex;
          align-items: center;
          gap: 8px;
          flex: 0 0 auto;
        }

        .topIconBtn {
          padding: 10px 12px;
          border-radius: 12px;
          border: 1px solid #ddd;
          background: #fff;
          cursor: pointer;
          font-size: 18px;
          line-height: 1;
        }
        .topIconBtn.disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .errorLine {
          padding: 8px 12px;
          color: #b00020;
          font-size: 13px;
          border-bottom: 1px solid #f3f4f6;
        }

        .chatArea {
          flex: 1 1 auto;
          min-height: 0;
          overflow-y: auto;
          padding: 14px;
          background: #fff;
        }

        /* Messages */
        .msgRow {
          margin: 12px 0;
          display: flex;
          width: 100%;
        }
        .userRow {
          justify-content: flex-end;
        }
        .asstRow {
          justify-content: flex-start;
          gap: 10px;
          align-items: flex-start;
        }

        .userBubble {
          max-width: 86%;
          padding: 10px 12px;
          border-radius: 14px;
          background: #f3f4f6;
          color: #111;
        }

        .msgTime {
          font-size: 11px;
          color: #777;
          margin-top: 8px;
          text-align: right;
        }

        .asstAvatar {
          flex: 0 0 auto;
          margin-top: 2px;
        }

        .asstBody {
          max-width: min(740px, 86%);
          width: 100%;
        }

        .asstNameLine {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 10px;
          margin-bottom: 6px;
        }

        .asstNameBtn {
          border: none;
          background: transparent;
          padding: 0;
          cursor: pointer;
          font-weight: 900;
          font-size: 13px;
          color: #111;
        }

        .asstTime {
          font-size: 11px;
          color: #999;
          white-space: nowrap;
        }

        .asstText {
          font-size: 15px;
        }

        .typingDots {
          margin-top: 6px;
          color: #666;
          font-size: 12px;
        }

        /* Input */
        .chatInputWrap {
          flex: 0 0 auto;
          padding: 10px 12px calc(12px + env(safe-area-inset-bottom));
          border-top: 1px solid #eee;
          background: #fff;
        }

        .sendArrowBtn {
          width: 44px;
          height: 44px;
          border-radius: 12px;
          border: 1px solid #ddd;
          background: #111;
          color: #fff;
          cursor: pointer;
          font-size: 18px;
          line-height: 1;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .sendArrowBtn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .inputDock {
          width: 100%;
          border: 1px solid #ddd;
          background: #fff;
          border-radius: 14px;
          padding: 12px 12px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          cursor: pointer;
        }
        .inputDock:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
        .dockPlaceholder {
          color: #777;
          font-size: 14px;
        }
        .dockArrow {
          width: 32px;
          height: 32px;
          border-radius: 10px;
          background: #111;
          color: #fff;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 16px;
          line-height: 1;
        }

        .disclaimerBottom {
          padding-top: 10px;
          font-size: 11px;
          color: #777;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        /* ===== Overlay common ===== */
        .overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.35);
          z-index: 200;
          display: flex;
          align-items: flex-end;
          justify-content: center;
          padding: 12px;
          box-sizing: border-box;
        }

        .overlayWhite {
          background: #fff;
          padding: 0;
          align-items: stretch;
        }

        .menuSheet {
          width: min(560px, 100%);
          background: #fff;
          border-top-left-radius: 16px;
          border-top-right-radius: 16px;
          border: 1px solid #ddd;
          border-bottom: none;
          padding-bottom: calc(12px + env(safe-area-inset-bottom));
          max-height: 90vh;
          overflow: auto;
        }

        .sheetTop {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px;
          border-bottom: 1px solid #eee;
          position: sticky;
          top: 0;
          background: #fff;
          z-index: 1;
        }

        .sheetSection {
          padding: 12px;
          border-top: 1px solid #eee;
        }

        .sheetLabel {
          font-weight: 900;
          margin-bottom: 8px;
        }

        /* ===== Full-screen sheet (Threads / Profile) ===== */
        .fullSheet {
          width: 100%;
          height: 100%;
          display: flex;
          flex-direction: column;
          background: #fff;
        }

        .fullTopBar {
          padding: calc(10px + env(safe-area-inset-top)) 12px 10px;
          border-bottom: 1px solid #eee;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          background: #fff;
          z-index: 10;
          flex: 0 0 auto;
        }

        .fullList {
          flex: 1 1 auto;
          min-height: 0;
          overflow-y: auto;
          padding: 12px;
          background: #fafafa;
        }

        .threadItemFull {
          width: 100%;
          text-align: left;
          padding: 10px;
          margin-bottom: 8px;
          border-radius: 12px;
          border: 1px solid #e5e5e5;
          background: #fff;
          cursor: pointer;
        }
        .threadItemFull.active {
          border: 2px solid #c7d2fe;
          background: #eef2ff;
        }

        /* ===== Composer ===== */
        .composerOverlay {
          position: fixed;
          inset: 0;
          background: #fff;
          z-index: 260;
          display: flex;
          flex-direction: column;
        }

        .composerTopBar {
          padding: calc(10px + env(safe-area-inset-top)) 12px 10px;
          border-bottom: 1px solid #eee;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          background: #fff;
        }

        .composerBody {
          flex: 1 1 auto;
          min-height: 0;
          padding: 12px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding-bottom: calc(12px + env(safe-area-inset-bottom));
        }

        .composerTextarea {
          width: 100%;
          flex: 1;
          border: 1px solid #ddd;
          border-radius: 14px;
          padding: 12px;
          font-size: 16px;
          line-height: 1.55;
          resize: none;
          outline: none;
        }

        .composerHint {
          font-size: 12px;
          color: #666;
        }
        .composerDisclaimer {
          font-size: 11px;
          color: #777;
        }

        /* ===== Profile overlay (full white) ===== */
        .overlayProfile {
          background: #fff !important;
          padding: 0 !important;
          align-items: stretch !important;
        }

        .profileSheet {
          width: 100%;
          height: 100%;
          margin: 0;
          border-radius: 0;
          border: none;
          box-shadow: none;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          background: #fff;
        }

        .profileBody {
          padding: 14px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          align-items: center;
          overflow-y: auto;
          padding-bottom: calc(14px + env(safe-area-inset-bottom));
        }

        .answerPreview {
          width: min(720px, 100%);
          border: 1px solid #eee;
          border-radius: 14px;
          padding: 12px;
          background: #fafafa;
        }
        .previewLabel {
          font-size: 12px;
          font-weight: 900;
          color: #111;
          margin-bottom: 8px;
        }
        .previewText {
          font-size: 13px;
          color: #111;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          line-height: 1.55;
          max-height: 42vh;
          overflow: auto;
        }

        /* Dots */
        .dots {
          display: inline-block;
          width: 18px;
          text-align: left;
          animation: dotty 1.2s infinite steps(4, end);
        }
        @keyframes dotty {
          0% {
            width: 0;
          }
          25% {
            width: 6px;
          }
          50% {
            width: 12px;
          }
          75% {
            width: 18px;
          }
          100% {
            width: 0;
          }
        }

        @media (max-width: 760px) {
          .pcOnly {
            display: none !important;
          }
          .spOnly {
            display: inline-flex !important;
          }

          .appBody {
            padding: 0;
          }

          .shell {
            width: 100%;
            height: 100%;
            border: none;
            border-radius: 0;
          }

          .chatArea {
            padding: 12px;
          }
        }
      `}</style>
    </div>
  );
}
