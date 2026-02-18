"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getSupabaseClient } from "@/app/lib/supabaseClient";
import { yuji } from "../fonts";

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

/** ===== utils ===== */
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
function isNearBottom(el: HTMLDivElement, px = 80) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < px;
}
function isHeadingLine(line: string): boolean {
  const raw = line.trim();
  if (!raw) return false;
  const t = raw.replace(/^#{1,6}\s*/, "").trim();
  const t2 = t.replace(/^【/, "").replace(/】$/, "").trim();
  const key = t2.replace(/[：:：\-–—].*$/, "").trim();
  // 見出し扱いを増やす（あなたの回答例に合わせる）
  if (key === "結論" || key === "要点" || key === "注意") return true;
  if (t2.startsWith("✅") || t2.startsWith("🔎") || t2.startsWith("🍚") || t2.startsWith("🧂") || t2.startsWith("🥄")) return true;
  return false;
}
function lineStyle(line: string): React.CSSProperties {
  const t = line.trim();
  if (!t) return { height: 10 } as any;

  if (isHeadingLine(line)) {
    return {
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
      lineHeight: 1.7,
      fontWeight: 800,
      color: "#111",
      paddingBottom: 8,
      marginTop: 6,
      borderBottom: "1px solid #e5e7eb",
    };
  }

  return {
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    lineHeight: 1.75,
    color: "#111",
  };
}
function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** ===== constants ===== */
const WELCOME_SEEN_KEY = "chat:welcomeSeen:v3";
const PINS_KEY = "chat:pins:v1";
const WELCOME_MESSAGE = [
  "はじめまして、税理士法人GLADZ代表税理士野口のAI、AI野口です。",
  "あなたの税務の悩みを「ちょうどさじかげん」で整理します。",
  "",
  "口調はメニュー（⋯）から固定できます（関西弁 / ズバっと など）。",
  "",
  "お好みのスタイルを選んで気軽にご相談ください",
].join("\n");

/** ===== main ===== */
export default function ChatClient() {
  const supabase = useMemo(() => getSupabaseClient(), []);
  const router = useRouter();

  const MAX_INPUT_LENGTH = 6000;
  const WARN_THRESHOLD = Math.floor(MAX_INPUT_LENGTH * 0.8); // 4800
  const cut = (s: string) => (s.length > MAX_INPUT_LENGTH ? s.slice(0, MAX_INPUT_LENGTH) : s);

  const [loading, setLoading] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const [plan, setPlan] = useState<string>("(loading)");
  const [usedTalks, setUsedTalks] = useState<number | null>(null);
  const [limitTalks, setLimitTalks] = useState<number | null>(null);

  const [dialect, setDialect] = useState<Dialect>(() => (loadLocal("chat:dialect") === "kansai" ? "kansai" : "standard"));
  const [stance, setStance] = useState<Stance>(() => (loadLocal("chat:stance") === "zubatto" ? "zubatto" : "sanbo"));

  const [threads, setThreads] = useState<ThreadItem[]>([]);
  const [threadsLoaded, setThreadsLoaded] = useState(false);

  const [activeConversationId, setActiveConversationId] = useState<string | null>(() => {
    const v = loadLocal("chat:activeConversationId");
    return v && isUuid(v) ? v : null;
  });

  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [input, setInput] = useState("");

  // iOSキーボード対策
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [keyboardPx, setKeyboardPx] = useState(0);

  // ✅ Bottom Sheet入力（ChatGPT/Gemini寄せ）
  const [inputSheetOpen, setInputSheetOpen] = useState(false);
  const [inputSheetText, setInputSheetText] = useState("");

  // overlays
  const [threadsOverlayOpen, setThreadsOverlayOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // optional fullscreen editor (120+ chars)
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerText, setComposerText] = useState("");

  // AI profile full screen (report/inquiry)
  const [aiProfileOpen, setAiProfileOpen] = useState(false);
  const [aiTargetText, setAiTargetText] = useState<string>("");

  // thread row menu (…)
  const [threadMenuOpen, setThreadMenuOpen] = useState(false);
  const [threadMenuTarget, setThreadMenuTarget] = useState<ThreadItem | null>(null);

  // sidebar
  const [sidebarMode, setSidebarMode] = useState<"open" | "collapsed">(
    () => (loadLocal("chat:sidebar") === "collapsed" ? "collapsed" : "open")
  );

  // avatar fallback
  const [aiAvatarOk, setAiAvatarOk] = useState(true);

  // pins (local)
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => {
    const raw = loadLocal(PINS_KEY);
    if (!raw) return new Set();
    try {
      const arr = JSON.parse(raw);
      return new Set(Array.isArray(arr) ? arr.map(String) : []);
    } catch {
      return new Set();
    }
  });

  // toast
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<any>(null);

  const msgsRef = useRef<HTMLDivElement | null>(null);
  const redirectingRef = useRef(false);
  const shouldAutoScrollRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const CONTACT_URL = process.env.NEXT_PUBLIC_CONTACT_URL || "mailto:support@example.com";
const FAQ_URL = process.env.NEXT_PUBLIC_FAQ_URL || "";
const TERMS_URL = process.env.NEXT_PUBLIC_TERMS_URL || "";
  const AI_AVATAR_URL = "/ai-noguchi.jpg";

  const BTN: CSSProperties = {
    padding: "8px 12px",
    borderRadius: 12,
    border: "1px solid #ddd",
    background: "#fff",
    cursor: "pointer",
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
    whiteSpace: "nowrap",
  });

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 1200);
  };

  const savePins = (next: Set<string>) => {
    setPinnedIds(new Set(next));
    saveLocal(PINS_KEY, JSON.stringify(Array.from(next)));
  };

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
    const target = el.scrollHeight;

    // 1) まずはネイティブsmoothを試す（効く環境はこれが一番気持ちいい）
    try {
      el.scrollTo({ top: target, behavior: "smooth" as ScrollBehavior });
    } catch {
      // ignore
    }

    // 2) iOS等でsmoothが効かない/弱い時のフォールバック：疑似高速スクロール
    const startTop = el.scrollTop;
    const dist = target - startTop;
    if (dist <= 0) return;

    const duration = 300; // ms（“なめらか感”）
    const t0 = performance.now();

    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = easeOutCubic(p);
      el.scrollTop = startTop + dist * eased;
      if (p < 1) requestAnimationFrame(step);
    };

    // smoothが効いてる環境でも “最後の押し込み” として動くので違和感は出にくい
    requestAnimationFrame(step);
  };

  /** ===== auth helpers ===== */
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

  /** ===== status / threads / messages ===== */
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

      // pinned first
      const pinSet = pinnedIds;
      items.sort((a, b) => {
        const ap = pinSet.has(a.id) ? 1 : 0;
        const bp = pinSet.has(b.id) ? 1 : 0;
        if (ap !== bp) return bp - ap;
        return 0;
      });

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
    setThreadsOverlayOpen(false);
    setMenuOpen(false);
  };

  const selectThread = (id: string) => {
    setActiveConversationId(id);
    saveLocal("chat:activeConversationId", id);
    setThreadsOverlayOpen(false);
  };

  const renameThreadById = async (id: string) => {
    const current = threads.find((t) => t.id === id)?.title || "";
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
        .eq("id", id)
        .eq("user_id", userId);

      if (error) throw error;

      setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)));
    } catch (e: any) {
      if (await handleAuthishError(e)) return;
      setErrMsg(e?.message || "rename failed");
    }
  };

  const deleteThreadById = async (id: string) => {
    const ok = window.confirm("このスレッドを削除します。よろしいですか？");
    if (!ok) return;

    try {
      const token = await getToken();
      if (!token) return await handleAuthishError("Not logged in");

      const { data: u, error: uErr } = await supabase.auth.getUser();
      if (uErr || !u?.user?.id) return await handleAuthishError("Not logged in");
      const userId = u.user.id;

      // conversations を消す（messages は FK で cascade or trigger を期待）
      const { error } = await supabase.from("conversations").delete().eq("id", id).eq("user_id", userId);
      if (error) throw error;

      // UI更新
      setThreads((prev) => prev.filter((t) => t.id !== id));
      const nextPins = new Set(pinnedIds);
      nextPins.delete(id);
      savePins(nextPins);

      if (activeConversationId === id) {
        newThread();
        await loadThreads();
      }
    } catch (e: any) {
      if (await handleAuthishError(e)) return;
      setErrMsg(e?.message || "delete failed");
    }
  };

  const togglePin = (id: string) => {
    const next = new Set(pinnedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    savePins(next);
    // 再ソート
    setThreads((prev) => {
      const items = [...prev];
      items.sort((a, b) => {
        const ap = next.has(a.id) ? 1 : 0;
        const bp = next.has(b.id) ? 1 : 0;
        if (ap !== bp) return bp - ap;
        return 0;
      });
      return items;
    });
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
  window.location.href = url;
};

const openUrlNewTab = (url: string) => {
  if (url.startsWith("http")) window.open(url, "_blank", "noreferrer");
  else window.location.href = url;
};


  const doLogout = async () => {
    await supabase.auth.signOut().catch(() => null);
    clearChatUiState();
    router.replace("/login");
  };

  const doCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast("コピーしました");
    } catch {
      showToast("コピー失敗");
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
    await doCopy(text);
  };

  const typeOutAssistant = async (assistantId: string, fullText: string) => {
    const full = String(fullText ?? "");
    if (!full) return;

    // code block は一括
    if (full.includes("```")) {
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: full } : m)));
      if (shouldAutoScrollRef.current) scrollBottom();
      return;
    }

    const chars = Array.from(full);
    const total = chars.length;

    let cps = 30;
    if (total >= 800) cps *= 1.15;
    if (total >= 1500) cps *= 1.25;

    const boostChars = 60;
    const boostFactor = 1.35;

    let idx = 0;
    let built = "";

    while (idx < total) {
      const next = chars[idx] ?? "";
      let chunkLen = 2;
      if (next === "\n") chunkLen = 1;
      if ("。！？!?".includes(next)) chunkLen = 1;
      if (chunkLen === 2 && Math.random() < 0.08) chunkLen = 3;

      const chunk = chars.slice(idx, idx + chunkLen).join("");
      idx += chunkLen;
      built += chunk;

      setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: built } : m)));

      if (shouldAutoScrollRef.current) scrollBottom();

      const isBoost = built.length <= boostChars;
      const speed = isBoost ? cps * boostFactor : cps;
      const perChar = 1000 / speed;
      let delay = Math.ceil(perChar * chunk.length);

      const last = chunk.slice(-1);
      if ("。！？!?".includes(last)) delay += 140;
      if (last === "\n") delay += 120;

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
    if (text.length > MAX_INPUT_LENGTH) {
      showToast(`長すぎるで（最大 ${MAX_INPUT_LENGTH} 文字）`);
      return;
    }

    setErrMsg(null);
    setLoading(true);
    setThinking(true);

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

  /** ===== effects ===== */
  // local defaults
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

  // collapse on mid screen first time
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

   // ✅ showJump を messages 増減でも更新（スクロール判定がズレる端末対策）
  useEffect(() => {
    const el = msgsRef.current;
    if (!el) return;
    const near = isNearBottom(el);
    setShowJump(!near);
  }, [messages.length]);

  // ✅ 初期表示でも↓ボタン判定（iOSでscrollイベントが遅い時の保険）
  useEffect(() => {
    const el = msgsRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      const near = isNearBottom(el);
      setShowJump(!near);
    });
  }, []);

  // ✅ iOSキーボード時に入力欄が浮く問題を潰す（visualViewport）
  useEffect(() => {
    const vv = (window as any).visualViewport;
    if (!vv) return;
    const onResize = () => {
      // ✅ iOS Safari安定版：
      // window.innerHeight はアドレスバー伸縮でブレるので layout viewport を使う
      const layoutH = document.documentElement.clientHeight || window.innerHeight;
      const offsetTop = typeof vv.offsetTop === "number" ? vv.offsetTop : 0;
      const kbRaw = layoutH - vv.height - offsetTop;
      const kb = Math.max(0, Math.round(kbRaw));
      setKeyboardPx(kb);
      setKeyboardOpen(kb > 0);
       // ✅ CSS変数に反映（CSS側で bottom に使う）
      try {
        document.documentElement.style.setProperty("--kb", `${kb}px`);
        document.documentElement.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
        document.documentElement.style.setProperty("--vvo", `${Math.round(offsetTop)}px`);
        // ✅ Bottom Sheet の見た目高さ（フルスクリーン禁止）
        const sheetH = Math.max(260, Math.min(560, Math.round(vv.height * 0.58)));
        document.documentElement.style.setProperty("--sheetH", `${sheetH}px`);
      } catch {}
    };
    vv.addEventListener("resize", onResize);
    vv.addEventListener("scroll", onResize);
    onResize();
    return () => {
     vv.removeEventListener("resize", onResize);
      vv.removeEventListener("scroll", onResize);
    };
  }, []);

  // welcome
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

  // lock body scroll for overlays (menu/thread/profile/threadMenu/composer)
  useEffect(() => {
    const anyOpen = menuOpen || threadsOverlayOpen || aiProfileOpen || threadMenuOpen || composerOpen || inputSheetOpen;
    if (!anyOpen) return;

    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [menuOpen, threadsOverlayOpen, aiProfileOpen, threadMenuOpen, composerOpen, inputSheetOpen]);

  /** ===== swipe left to open threads overlay ===== */
  const swipeRef = useRef<{ x: number; y: number; active: boolean }>({ x: 0, y: 0, active: false });
  const onTouchStart = (e: React.TouchEvent) => {
    if (threadsOverlayOpen || menuOpen || composerOpen || aiProfileOpen || threadMenuOpen) return;
    const t = e.touches[0];
    swipeRef.current = { x: t.clientX, y: t.clientY, active: true };
  };

  const onTouchEnd = (e: React.TouchEvent) => {
  const st = swipeRef.current;
  if (!st.active) return;
  swipeRef.current.active = false;

  const t = e.changedTouches[0];
  const dx = t.clientX - st.x;
  const dy = t.clientY - st.y;

  // 縦スクロール優先
  if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.3) return;

  // ✅ overlay開いてる時は “右→左” で閉じるだけ
  if (threadsOverlayOpen) {
    if (dx < -70) setThreadsOverlayOpen(false);
    return;
  }

  // ✅ 左端スタート限定で “左→右” で開く
  const fromLeftEdge = st.x < 60; // 60くらいがiOSの戻るジェスチャと喧嘩しにくい
  if (fromLeftEdge && dx > 70) {
    setThreadsOverlayOpen(true);
    return;
  }
};

  /** ===== helpers ===== */
  const openAiProfileFromAnswer = (text: string) => {
    setAiTargetText(text);
    setAiProfileOpen(true);
  };

  // 段落ブロック区切り（話題っぽい区切り）
  const renderAssistantContent = (rawContent: string) => {
    const content = stripCatchphraseIfThreePatterns(rawContent);
    const normalized = content.replace(/\r\n/g, "\n").trimEnd();

    // 2連続改行で段落ブロック化
    const blocks = normalized.split(/\n{2,}/g).map((b) => b.trim()).filter(Boolean);

    return (
      <div className="asstBlocks">
        {blocks.map((block, bi) => {
          const lines = block.split("\n");
          const isLast = bi === blocks.length - 1;
          return (
            <div key={bi} className={`asstBlock ${isLast ? "last" : ""}`}>
              {lines.map((line, i) => {
                if (!line.trim()) return <div key={i} style={{ height: 10 }} />;
                return (
                  <div key={i} style={lineStyle(line)}>
                    {renderBoldInline(line)}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  };

  const activeTitle = (activeConversationId && threads.find((t) => t.id === activeConversationId)?.title) || "(新規)";
  const showExpand = (input ?? "").length >= 120;
  const showExpandSheet = (inputSheetText ?? "").length >= 120;

  return (
   <div className="appRoot">
      <div className="appBody">
        <div className="shell">
          {/* PC/Tablet: 左スレッド */}
          <div className={`threadCol pcOnly ${sidebarMode === "collapsed" ? "collapsed" : ""}`}>
            <div className="threadColTop">
              <div style={{ fontWeight: 900 }}>スレッド</div>
              <button type="button" style={BTN} onClick={() => newThread()}>
                新規
              </button>
            </div>

            <div className="threadList">
              {threads.map((t) => {
                const active = t.id === activeConversationId;
                const pinned = pinnedIds.has(t.id);

                return (
                  <div key={t.id} className={`threadRow ${active ? "active" : ""}`}>
                    <button
                      type="button"
                      className="threadMain"
                      onClick={() => {
                        setActiveConversationId(t.id);
                        saveLocal("chat:activeConversationId", t.id);
                      }}
                      title={t.title}
                    >
                      <div className="threadTitleLine">
                        <span className="threadTitle">{t.title}</span>
                        {pinned && <span className="pinMark" title="ピン留め">📌</span>}
                      </div>
                                          </button>

                    <button
                      type="button"
                      className="threadMore"
                      aria-label="スレッド操作"
                      title="スレッド操作"
                      onClick={() => {
                        setThreadMenuTarget(t);
                        setThreadMenuOpen(true);
                      }}
                    >
                      ⋯
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 右：チャット本体 */}
          <div className="chatCol">
            {/* 1行ヘッダー（SPは≡） */}
            <div className="topBar">
              <div className="topLeft">
                <button
                  type="button"
                  className="spOnly topIconBtn"
                  onClick={() => setThreadsOverlayOpen(true)}
                  aria-label="スレッド"
                  title="スレッド"
                >
                  ≡
                </button>

                <button
                  type="button"
                  className="pcOnly topIconBtn"
                  onClick={() => setSidebarMode((p) => (p === "open" ? "collapsed" : "open"))}
                  aria-label="スレッド"
                  title="スレッド"
                >
                  ☰
                </button>

                <div className="appBrand" title="さじかげん">
  <img src="/sa-logo.png" alt="さ" className="appLogo" />
  <span className={`appTitleText ${yuji.className}`}>じかげん</span>
</div>


              </div>

              <div className="topRight">
                <button type="button" className="topIconBtn" onClick={() => newThread()} aria-label="新規" title="新規">
                  ＋
                </button>
                <button type="button" className="topIconBtn" onClick={() => setMenuOpen(true)} aria-label="メニュー" title="メニュー">
                  ⋯
                </button>
              </div>
            </div>

            {errMsg && <div className="errorLine">{errMsg}</div>}

            <div
              ref={msgsRef}
              className="chatArea"
              onScroll={() => {
                const el = msgsRef.current;
                if (!el) return;
                const near = isNearBottom(el);
                shouldAutoScrollRef.current = near;
                setShowJump(!near);
              }}
            >
              {/* PCだけ薄くスレッド名 */}
              <div className="pcOnly" style={{ fontSize: 12, color: "#777", marginBottom: 6 }}>
                {activeTitle}
              </div>

              {messages.map((m, idx) => {
                const role = normalizeRole((m as any).role);
                const isUser = role === "user";
                const raw = String(m.content ?? "");
                const content = isUser ? raw : stripCatchphraseIfThreePatterns(raw);
                const isWelcome = m.id === "welcome";

                if (isUser) {
                  return (
                    <div key={m.id ?? idx} className="msgRow userRow">
                      <div className="userBubble">
                        <div className="bubbleText">{content}</div>
                        <div className="msgTime">{toHm(m.created_at)}</div>
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={m.id ?? idx} className="msgRow asstRow">
                    <div className="asstAvatar">
                      {aiAvatarOk ? (
                        <img
                          src={AI_AVATAR_URL}
                          alt="AI野口"
                          onClick={() => openAiProfileFromAnswer(content)}
                          onError={() => setAiAvatarOk(false)}
                          className="avatarImg"
                        />
                      ) : (
                        <div className="avatarFallback" onClick={() => openAiProfileFromAnswer(content)} title="AI野口">
                          🤖
                        </div>
                      )}
                    </div>

                    <div className="asstBody">
                      <div className="asstNameLine">
                        <button type="button" className="asstNameBtn" onClick={() => openAiProfileFromAnswer(content)}>
                          AI野口
                        </button>
                        <span className="asstTime">{toHm(m.created_at)}</span>
                      </div>

                      <div className="asstText">
                        {renderAssistantContent(raw)}
                      </div>

                      {!isWelcome && (
                        <div className="asstDisclaimer">※ AIの回答は参考情報です。最終判断はご自身でお願いします。</div>
                      )}

                      {!isWelcome && (
                        <div className="asstActions">
                          <button type="button" className="actBtn" title="コピー" aria-label="コピー" onClick={() => doCopy(content)}>
                            ⧉
                          </button>
                          <button type="button" className="actBtn" title="共有" aria-label="共有" onClick={() => doShare(content)}>
                            ↗︎
                          </button>
                          <button
                            type="button"
                            className="actBtn"
                            title="不適切な回答を報告"
                            aria-label="不適切な回答を報告"
                            onClick={() => openAiProfileFromAnswer(content)}
                          >
                            ⚑
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* 回答中（ここで動く … を出す） */}
              {thinking && (
                <div className="msgRow asstRow">
                  <div className="asstAvatar">
                    {aiAvatarOk ? <img src={AI_AVATAR_URL} alt="AI野口" className="avatarImg" /> : <div className="avatarFallback">🤖</div>}
                  </div>
                  <div className="asstBody">
                    <div className="thinkingLine">
                      <span>考え中</span>
                      <span className="dotsBounce" aria-hidden="true">
   <i />
   <i />
   <i />
 </span>
                    </div>
                  </div>
                </div>
              )}

              {/* 最下部へジャンプ */}
              {showJump && (
                <button
                  type="button"
                  className="jumpBtn"
                  onClick={() => {
                    shouldAutoScrollRef.current = true;
                    scrollBottom();
                  }}
                  aria-label="最下部へ"
                  title="最下部へ"
                >
                  ↓
                </button>
              )}
            </div>

            {/* 入力（1行固定） */}
            <div className={`chatInputWrap ${keyboardOpen ? "kbOpen" : ""} ${inputSheetOpen ? "hiddenWhenSheet" : ""}`}>
              <div className="inputRow">
                {/* PCは従来通り */}
                <div className="pcOnly" style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%" }}></div><div className="pcOnly" style={{ display: "flex", gap: 8, alignItems: "center", width: "100%" }}>
                  <input
                    value={input}
                    onChange={(e) => setInput(cut(e.target.value))}
                    onCompositionEnd={(e) => setInput(cut((e.target as HTMLInputElement).value))}
                    maxLength={MAX_INPUT_LENGTH}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        if (canSend) sendMessage();
                      }
                    }}
                    placeholder={loading ? "回答中…" : "相談内容を入力"}
                    className="chatInput"
                    disabled={!canSend}
                  />
                  {input.length >= WARN_THRESHOLD && (
     <div className={`charCount ${input.length >= MAX_INPUT_LENGTH ? "limit" : ""}`}>
       残り {MAX_INPUT_LENGTH - input.length} 文字
     </div>
   )}

                                  </div>

                {/* SPは“ダミー”→タップでBottom Sheet */}
                <button
                  type="button"
                  className="spOnly inputDock"
                  onClick={() => {
                    if (!canSend) return;
                    setInputSheetText(cut(input));
                    setInputSheetOpen(true);
                    // iOS: open直後フォーカスが外れることがあるので、sheet側でautoFocusする
                  }}
                  disabled={!canSend}
                >
                  <span className="dockPlaceholder">{loading ? "回答中…" : "相談内容を入力"}</span>
                </button>

                {showExpand && (
                  <button
                    type="button"
                    className="expandBtn"
                    onClick={() => {
                      setComposerText(cut(input));
                      setComposerOpen(true);
                    }}
                    aria-label="全画面で編集"
                    title="全画面で編集"
                    disabled={!canSend}
                  >
                    全画面
                  </button>
                )}

                             

                <button
                  type="button"
                  className="sendBtn"
                  onClick={() => {
                    if (canSend) sendMessage();
                  }}
                  disabled={!canSend || input.length > MAX_INPUT_LENGTH}
                >
                  送信
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ===== Toast ===== */}
      {toast && <div className="toast">{toast}</div>}

      {/* ===== スレッド overlay（SP） ===== */}
      {threadsOverlayOpen && (
        <div className="overlay overlayWhite" role="dialog" aria-modal="true">
          <div className="fullSheet">
            <div className="fullTopBar">
              <button type="button" className="topIconBtn" onClick={() => setThreadsOverlayOpen(false)} aria-label="閉じる" title="閉じる">
                戻る
              </button>
              <div style={{ fontWeight: 900 }}>スレッド</div>
              <button type="button" className="topIconBtn" onClick={() => newThread()} aria-label="新規" title="新規">
                ＋
              </button>
            </div>

            <div className="fullList">
              {threads.map((t) => {
                const active = t.id === activeConversationId;
                const pinned = pinnedIds.has(t.id);
                return (
                  <div key={t.id} className={`threadRowFull ${active ? "active" : ""}`}>
                    <button type="button" className="threadMain" onClick={() => selectThread(t.id)}>
                      <div className="threadTitleLine">
                        <span className="threadTitle">{t.title}</span>
                        {pinned && <span className="pinMark">📌</span>}
                      </div>
                                          </button>

                    <button
                      type="button"
                      className="threadMore"
                      aria-label="スレッド操作"
                      title="スレッド操作"
                      onClick={() => {
                        setThreadMenuTarget(t);
                        setThreadMenuOpen(true);
                      }}
                    >
                      ⋯
                    </button>
                  </div>
                );
              })}
              {threads.length === 0 && (
                <div style={{ padding: 16, color: "#666", fontSize: 13 }}>スレッドがありません。右上の「＋」で作れます。</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ===== スレッド「…」メニュー ===== */}
      {threadMenuOpen && threadMenuTarget && (
        <div className="overlay" role="dialog" aria-modal="true" onClick={() => setThreadMenuOpen(false)}>
          <div className="menuSheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheetTop">
              <div style={{ fontWeight: 900, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {threadMenuTarget.title}
              </div>
              <button type="button" style={BTN} onClick={() => setThreadMenuOpen(false)}>
                閉じる
              </button>
            </div>

            <div className="sheetSection">
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <button
                  type="button"
                  style={{ ...BTN, width: "100%" }}
                  onClick={() => {
                    setThreadMenuOpen(false);
                    renameThreadById(threadMenuTarget.id);
                  }}
                >
                  名前の変更
                </button>

                <button
                  type="button"
                  style={{ ...BTN, width: "100%" }}
                  onClick={() => {
                    togglePin(threadMenuTarget.id);
                    setThreadMenuOpen(false);
                  }}
                >
                  {pinnedIds.has(threadMenuTarget.id) ? "ピン解除" : "ピン止め"}
                </button>

                <button
                  type="button"
                  style={{ ...BTN, width: "100%" }}
                  onClick={async () => {
                    await doShare(`さじかげん｜スレッド: ${threadMenuTarget.title}`);
                    setThreadMenuOpen(false);
                  }}
                >
                  共有
                </button>

                <button
                  type="button"
                  style={{ ...BTN, width: "100%", borderColor: "#fca5a5", color: "#b91c1c" }}
                  onClick={async () => {
                    setThreadMenuOpen(false);
                    await deleteThreadById(threadMenuTarget.id);
                  }}
                >
                  削除
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ===== メニュー（⋯）— スレッド操作は撤去 ===== */}
      {menuOpen && (
        <div className="overlay" role="dialog" aria-modal="true" onClick={() => setMenuOpen(false)}>
          <div className="menuSheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheetTop">
              <div style={{ fontWeight: 900 }}>メニュー</div>
              <button type="button" style={BTN} onClick={() => setMenuOpen(false)}>
                閉じる
              </button>
            </div>

            <div className="sheetSection">
              <div className="sheetLabel">利用状況</div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ fontSize: 12, color: "#333", fontWeight: 800 }}>{badge}</div>
                <button type="button" style={{ ...BTN, minWidth: 78 }} onClick={() => refreshStatus()}>
                  更新
                </button>
              </div>
            </div>

            <div className="sheetSection">
  <div className="sheetLabel">スタイル</div>

  <div className="styleRow">
    <div className="styleGroup">
      <div className="styleMiniLabel">口調</div>
      <div className="btnRow">
        <button type="button" style={toggleBtn(dialect === "standard")} onClick={() => setDialect("standard")}>
          標準語
        </button>
        <button type="button" style={toggleBtn(dialect === "kansai")} onClick={() => setDialect("kansai")}>
          関西弁
        </button>
      </div>
    </div>

    <div className="styleGroup">
      <div className="styleMiniLabel">モード</div>
      <div className="btnRow">
        <button type="button" style={toggleBtn(stance === "sanbo")} onClick={() => setStance("sanbo")}>
          参謀
        </button>
        <button type="button" style={toggleBtn(stance === "zubatto")} onClick={() => setStance("zubatto")}>
          ズバっと
        </button>
      </div>
    </div>
  </div>
</div>


            <div className="sheetSection">
  <div className="sheetLabel">ヘルプ</div>
  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
    <button
      type="button"
      style={{ ...BTN, width: "100%" }}
      onClick={() => {
        setMenuOpen(false);
        openUrl(FAQ_URL); // ✅ 同一タブ
      }}
    >
      FAQ
    </button>

    <button
      type="button"
      style={{ ...BTN, width: "100%" }}
      onClick={() => {
        setMenuOpen(false);
        openUrl(TERMS_URL); // ✅ 同一タブ
      }}
    >
      利用規約
    </button>
  </div>
</div>


            <div className="sheetSection">
              <div className="sheetLabel">その他</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <Link href="/settings/billing" style={{ ...LINK_BTN, width: "100%" }} onClick={() => setMenuOpen(false)}>
                  プラン変更
                </Link>
                <button
                  type="button"
                  style={{ ...BTN, width: "100%" }}
                  onClick={() => {
                    setMenuOpen(false);
                    openUrl(CONTACT_URL);
                  }}
                >
                  お問い合わせ
                </button>
                <button
                  type="button"
                  style={{ ...BTN, width: "100%" }}
                  onClick={() => {
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

      {/* ===== 全画面入力（任意：120文字以上から） ===== */}
      {composerOpen && (
        <div className="composerOverlay" role="dialog" aria-modal="true">
          <div className="composerTopBar">
            <button type="button" className="topIconBtn" 
            onClick={() => {
               setComposerOpen(false);
               setInput(cut(composerText));
             }}
            aria-label="戻る" title="戻る">
              ←
            </button>
            <div style={{ fontWeight: 900 }}>相談内容</div>
            <button
              type="button"
              className={`composerSendBtn ${!canSend || !composerText.trim() || composerText.length > MAX_INPUT_LENGTH ? "disabled" : ""}`}
              onClick={() => {
                if (!canSend) return;
                if (!composerText.trim()) return;
                sendMessage(composerText);
              }}
              disabled={!canSend || !composerText.trim() || composerText.length > MAX_INPUT_LENGTH}
            >
              送信
            </button>
          </div>

          <div className="composerBody">
            <textarea
  value={composerText}
   onChange={(e) => setComposerText(cut(e.target.value))}
  onCompositionEnd={(e) => setComposerText(cut((e.target as HTMLTextAreaElement).value))}
 maxLength={MAX_INPUT_LENGTH}
  placeholder="相談内容を入力してください"
  className="composerTextarea"
  autoFocus
/>

{composerText.length >= WARN_THRESHOLD && (
  <div className={`charCount ${composerText.length >= MAX_INPUT_LENGTH ? "limit" : ""}`}>
    残り {MAX_INPUT_LENGTH - composerText.length} 文字
  </div>
)}

          </div>
        </div>
      )}

      {/* ===== AI野口プロフィール（フル） ===== */}
      {aiProfileOpen && (
        <div className="overlay overlayProfile" role="dialog" aria-modal="true" onClick={() => setAiProfileOpen(false)}>
          <div className="profileSheet" onClick={(e) => e.stopPropagation()}>
            <div className="fullTopBar">
              <div style={{ fontWeight: 900 }}>AI野口</div>
              <button type="button" style={BTN} onClick={() => setAiProfileOpen(false)}>
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
                <div style={{ fontWeight: 900, fontSize: 18 }}>AI野口</div>
                <div style={{ color: "#666", fontSize: 13, marginTop: 4 }}>税理士法人GLADZ 代表税理士 野口のAI</div>
              </div>

              {aiTargetText && (
                <div className="answerPreview">
                  <div className="previewLabel">対象の回答</div>
                  <div className="previewText">{aiTargetText}</div>
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
                <button type="button" style={{ ...BTN, width: "100%", padding: "12px 12px" }} onClick={() => openUrl(CONTACT_URL)}>
                  不適切な回答を報告
                </button>

                <button type="button" style={{ ...BTN, width: "100%", padding: "12px 12px" }} onClick={() => openUrl(CONTACT_URL)}>
                  問い合わせ・要望など
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ===== SP: Bottom Sheet Input（ChatGPT/Gemini寄せ） ===== */}
      {inputSheetOpen && (
        <div
          className="sheetOverlay"
          role="dialog"
          aria-modal="true"
          onClick={() => {
            setInput(cut(inputSheetText));
            setInputSheetOpen(false);
          }}
        >
          <div className="inputSheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheetTop">
              <div className="sheetLeft">
    <button
      type="button"
      className="sheetBtn"
      onClick={(e) => {
        e.stopPropagation();
        setInput(cut(inputSheetText));
        setInputSheetOpen(false);
      }}
    >
      戻る
    </button>

    {/* ✅ 口調変更（ここ） */}
    <button
      type="button"
      className="sheetBtn"
      onClick={(e) => {
        e.stopPropagation();
        // 既存の menuOpen は z-index が低くて Sheet の裏に潜るので、ここは“その場切替”にする
        setDialect((p) => (p === "standard" ? "kansai" : "standard"));
      }}
      title="口調（標準語/関西弁）"
    >
      {dialect === "kansai" ? "関西弁" : "標準語"}
    </button>

    <button
      type="button"
      className="sheetBtn"
      onClick={(e) => {
        e.stopPropagation();
        setStance((p) => (p === "sanbo" ? "zubatto" : "sanbo"));
      }}
      title="モード（参謀/ズバっと）"
    >
      {stance === "sanbo" ? "参謀" : "ズバ"}
    </button>
  </div>

              <div className="sheetTitle">相談内容</div>

              <div className="sheetRight">
                {showExpandSheet && (
                  <button
                    type="button"
                    className="sheetBtn"
                    onClick={() => {
                      setComposerText(cut(inputSheetText));
 setInput(cut(inputSheetText));
                      setInputSheetOpen(false);
                      setComposerOpen(true);
                    }}
                  >
                    全画面
                  </button>
                )}

                <button
                  type="button"
                  className={`sheetBtnPrimary ${!inputSheetText.trim() ? "disabled" : ""}`}
                  disabled={!inputSheetText.trim() || !canSend || inputSheetText.length > MAX_INPUT_LENGTH}
                  onClick={(e) => {
   e.stopPropagation();
                    if (!canSend) return;
                    const v = inputSheetText.trim();
                    if (!v) return;
                    setInputSheetOpen(false);
                    setInputSheetText("");
                    sendMessage(v);
                  }}
                >
                  送信
                </button>
              </div>
            </div>

            <div className="sheetBody">
              <textarea
  value={inputSheetText}
  onChange={(e) => setInputSheetText(cut(e.target.value))}
  onCompositionEnd={(e) => setInputSheetText(cut((e.target as HTMLTextAreaElement).value))}
 maxLength={MAX_INPUT_LENGTH}
  placeholder="相談内容を入力"
  className="sheetTextarea"
  autoFocus
/>

{inputSheetText.length >= WARN_THRESHOLD && (
  <div className={`charCount ${inputSheetText.length >= MAX_INPUT_LENGTH ? "limit" : ""}`}>
    残り {MAX_INPUT_LENGTH - inputSheetText.length} 文字
  </div>
)}


              <div className="sheetHint">※ 口調はメニュー（⋯）から固定できます。</div>
            </div>
          </div>
        </div>
      )}


      {/* ===== styles ===== */}
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
          padding: 10px;
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

        /* ===== Thread ===== */
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
          -webkit-overflow-scrolling: touch;
        }

        .threadRow {
          display: flex;
          gap: 8px;
          align-items: stretch;
          margin-bottom: 8px;
        }
        .threadRow.active .threadMain {
          border: 2px solid #c7d2fe;
          background: #eef2ff;
        }

        .threadMain {
          flex: 1;
          text-align: left;
          padding: 10px;
          border-radius: 12px;
          border: 1px solid #e5e5e5;
          background: #fff;
          cursor: pointer;
        }

        .threadMore {
          width: 42px;
          border-radius: 12px;
          border: 1px solid #e5e5e5;
          background: #fff;
          cursor: pointer;
          font-size: 18px;
          line-height: 1;
        }

        .threadTitleLine {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 0;
        }

        .threadTitle {
          font-weight: 500; /* 太字やめる */
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: 100%;
        }

        /* 横スクロール防止（特にSP overlay） */
        .threadMain { min-width: 0; overflow: hidden; }
        .threadRowFull, .threadRow { overflow: hidden; }
        
        .pinMark {
          flex: 0 0 auto;
          font-size: 14px;
        }

        .threadMeta {
           display: none;
        }

        .threadPreview {
          display: none;
        }

        /* ===== Chat ===== */
        .chatCol {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-height: 0;
          background: #fff;
        }

        /* 上下固定の幅を縮める */
        .topBar {
          padding: calc(2px + env(safe-area-inset-top)) 8px 2px;
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

        /* ロゴ＋じかげん（トップバー専用に限定） */
.topBar .appBrand{
  display:flex;
  align-items:center;
  gap:6px;
}

.topBar .appLogo{
  width:22px;
  height:22px;
  object-fit:contain;
  display:block;
  transform: translateY(-1px);
}

/* ここが肝：元の .appTitle と同じ“強さ”を戻す */
.topBar .appTitleText{
  font-size:18px;
  font-weight:900;
  letter-spacing:0.08em;
  line-height:1;
  white-space:nowrap;
  display:inline-block;
  transform: translateY(1px);
}



@media (max-width: 760px){
  .appLogo{ width:24px; height:24px; }
  .appTitleText{ font-size:17px; }
}


        .topRight {
          display: flex;
          align-items: center;
          gap: 8px;
          flex: 0 0 auto;
        }

        .topIconBtn {
          padding: 8px 10px;
          border-radius: 12px;
          border: 1px solid #ddd;
          background: #fff;
          cursor: pointer;
          font-size: 18px;
          line-height: 1;
        }

        .errorLine {
          padding: 8px 10px;
          color: #b00020;
          font-size: 13px;
          border-bottom: 1px solid #f3f4f6;
        }

        .chatArea {
          flex: 1 1 auto;
          min-height: 0;
          overflow-y: auto;
          padding: 12px;
          background: #fff;
          position: relative;
          -webkit-overflow-scrolling: touch;
          touch-action: pan-y;
          overscroll-behavior: contain;
        }

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

        .bubbleText {
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          line-height: 1.8;
          font-size: 17px;
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

        .avatarImg {
          width: 26px;
          height: 26px;
          display: block;
          border-radius: 999px;
          object-fit: cover;
          border: 1px solid #e5e5e5;
          cursor: pointer;
        }

        .avatarFallback {
          width: 26px;
          height: 26px;
          border-radius: 999px;
          border: 1px solid #e5e5e5;
          background: #fff;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 12px;
          cursor: pointer;
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
          font-size: 17px; /* 質問と同じ（大きめ） */
        }

        /* 段落ブロック間の薄い線（話題区切り） */
        .asstBlocks {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .asstBlock {
          padding-bottom: 12px;
          border-bottom: 1px solid #eef2f7;
        }
        .asstBlock.last {
          border-bottom: none;
          padding-bottom: 0;
        }

        .asstDisclaimer {
          margin-top: 10px;
          font-size: 11px;
          color: #777;
        }

        .asstActions {
          margin-top: 6px;
          display: flex;
          justify-content: flex-end;
          gap: 6px;
        }

        .actBtn {
          width: 28px;
          height: 28px;
          border-radius: 10px;
          border: 1px solid #e5e5e5;
          background: #fff;
          cursor: pointer;
          font-size: 14px;
          line-height: 1;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          color: #444;
        }

        .thinkingLine {
          font-size: 13px;
          color: #666;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 0;
        }

        .jumpBtn {
          /* ✅ スクロール領域に埋め込まず fixed で確実に出す */
          position: fixed;
          right: 12px;
          bottom: calc(74px + env(safe-area-inset-bottom));
          width: 44px;
          height: 44px;
          border-radius: 14px;
          border: 1px solid #ddd;
          background: #fff;
          cursor: pointer;
          box-shadow: 0 6px 20px rgba(0, 0, 0, 0.08);
          font-size: 18px;
           z-index: 120;
        }

        .chatInputWrap {
          flex: 0 0 auto;
          padding: 6px 10px calc(6px + env(safe-area-inset-bottom));
          border-top: 1px solid #eee;
          background: #fff;
        }

        .inputRow {
          display: flex;
          gap: 8px;
          align-items: center;
        }
          /* ✅ iOSキーボード表示時：余白を詰めて入力欄をキーボードに寄せる */
        .chatInputWrap.kbOpen {
          padding-bottom: 8px;
        }

        .charCount{
  font-size:12px;
  color:#666;
  margin-top:6px;
  text-align:right;
}
.charCount.limit{
  color:#b91c1c;
  font-weight:700;
}


         /* ✅ SPダミー入力（dock） */
        .inputDock {
          flex: 1 1 auto;
          min-width: 0;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 10px 10px;
          border-radius: 14px;
          border: 1px solid #ddd;
          background: #fff;
          cursor: pointer;
        }
        .inputDock:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
        .dockPlaceholder {
          color: #777;
          font-size: 16px;
        }
        
        /* Sheet表示中は下の入力バーを隠す */
        .hiddenWhenSheet { display: none; }

        /* ✅ Bottom Sheet Overlay */
        .sheetOverlay {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.18);
          z-index: 260;
          display: flex;
          align-items: flex-end;
          justify-content: center;
        }
        .inputSheet {
          position: fixed;
          left: 0;
          right: 0;
          bottom: var(--kb, 0px);
          height: var(--sheetH, 360px);
          max-height: calc(var(--vvh, 100dvh) - 12px);
          background: #fff;
          border-top-left-radius: 16px;
          border-top-right-radius: 16px;
          box-shadow: 0 -16px 40px rgba(0,0,0,0.12);
          display: flex;
          flex-direction: column;
        }
        .inputSheet .sheetTop {
  padding: 10px 12px;
  border-bottom: 1px solid #eee;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

          
        .sheetTitle { font-weight: 900; }
        .sheetBtn {
          padding: 8px 10px;
          border-radius: 12px;
          border: 1px solid #ddd;
          background: #fff;
          cursor: pointer;
          font-size: 13px;
        }
        .sheetBtnPrimary {
          padding: 8px 12px;
          border-radius: 12px;
          border: 1px solid #111;
          background: #111;
          color: #fff;
          cursor: pointer;
          font-size: 13px;
          font-weight: 900;
        }
          .sheetRight{
  display:flex;
  gap:8px;
  align-items:center;
  flex:0 0 auto;
}

.sheetLeft{
  display:flex;
  gap:8px;
  align-items:center;
  flex:0 0 auto;
  min-width:0;
}


        .sheetBtnPrimary.disabled { opacity: 0.5; cursor: not-allowed; }
        .sheetBody {
          flex: 1 1 auto;
          min-height: 0;
          padding: 12px;
          padding-bottom: calc(12px + env(safe-area-inset-bottom));
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .sheetTextarea {
          flex: 1;
          width: 100%;
          border: 1px solid #ddd;
          border-radius: 14px;
          padding: 12px;
          font-size: 16px;
          line-height: 1.7;
          resize: none;
          outline: none;
        }
        .sheetHint { font-size: 12px; color: #666; }

        .chatInput {
          flex: 1;
          padding: 8px 12px calc(10px + env(safe-area-inset-bottom));
          border-radius: 12px;
          border: 1px solid #ddd;
          font-size: 16px;
        }

        .expandBtn {
          padding: 10px 10px;
          border-radius: 12px;
          border: 1px solid #ddd;
          background: #fff;
          cursor: pointer;
          white-space: nowrap;
          font-size: 13px;
        }

        .sendBtn {
          padding: 9px 12px;
          border-radius: 12px;
          border: 1px solid #111;
          background: #111;
          color: #fff;
          cursor: pointer;
          white-space: nowrap;
          font-size: 13px;
          font-weight: 800;
        }
        .sendBtn:disabled,
        .expandBtn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        /* overlay */
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

        /* menu: “閉じる”を確実に押せる */
        .menuSheet {
          width: min(560px, 100%);
          background: #fff;
          border-top-left-radius: 16px;
          border-top-right-radius: 16px;
          border: 1px solid #ddd;
          border-bottom: none;
          padding-bottom: calc(12px + env(safe-area-inset-bottom));
          max-height: calc(100dvh - 16px);
          overflow: auto;
        }

        /* PC: 2カラム / SP: 1カラム に固定 */
.styleRow{
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  align-items: start;
}

@media (max-width: 760px){
  .styleRow{
    grid-template-columns: 1fr; /* SPは2段（縦） */
  }
}

.styleGroup{
  min-width: 0; /* これ大事：はみ出しで崩れない */
}

.styleMiniLabel{
  font-size:12px;
  font-weight:900;
  color:#444;
  margin-bottom:8px;
}

.btnRow{
  display:flex;
  gap:10px;
  flex-wrap:wrap;
}


        .menuSheet .sheetTop {
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

        /* full sheet */
        .fullSheet {
          width: 100%;
          height: 100%;
          display: flex;
          flex-direction: column;
          background: #fff;
        }

        .fullTopBar {
          padding: calc(2px + env(safe-area-inset-top)) 8px 2px;
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
          -webkit-overflow-scrolling: touch;
          touch-action: pan-y;
        }

        .threadRowFull {
          display: flex;
          gap: 8px;
          align-items: stretch;
          margin-bottom: 8px;
        }
        .threadRowFull.active .threadMain {
          border: 2px solid #c7d2fe;
          background: #eef2ff;
        }

        /* composer */
        .composerOverlay {
          position: fixed;
          inset: 0;
          background: #fff;
          z-index: 260;
          display: flex;
          flex-direction: column;
        }

        .composerTopBar {
          padding: calc(6px + env(safe-area-inset-top)) 10px 6px;
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
          padding-bottom: calc(12px + env(safe-area-inset-bottom));
        }

        .composerTextarea {
          width: 100%;
          flex: 1;
          border: 1px solid #ddd;
          border-radius: 14px;
          padding: 12px;
          font-size: 16px;
          line-height: 1.7;
          resize: none;
          outline: none;
        }

        .composerSendBtn {
          padding: 8px 12px;
          border-radius: 12px;
          border: 1px solid #111;
          background: #111;
          color: #fff;
          font-weight: 900;
          cursor: pointer;
        }
        .composerSendBtn.disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        /* profile */
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
          -webkit-overflow-scrolling: touch;
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
          line-height: 1.6;
          max-height: 42vh;
          overflow: auto;
          -webkit-overflow-scrolling: touch;
        }

        /* toast */
        .toast {
          position: fixed;
          left: 50%;
          bottom: calc(18px + env(safe-area-inset-bottom));
          transform: translateX(-50%);
          background: rgba(17, 17, 17, 0.92);
          color: #fff;
          padding: 10px 14px;
          border-radius: 999px;
          font-size: 13px;
          z-index: 400;
          pointer-events: none;
        }

        .dotsBounce{
  display:inline-flex;
  gap:4px;
  align-items:center;
  height:12px;
}
.dotsBounce i{
  width:4px;
  height:4px;
  border-radius:999px;
  background:#666;
  display:inline-block;
  animation: bounceDot 1.1s infinite ease-in-out;
}
.dotsBounce i:nth-child(2){ animation-delay: .15s; }
.dotsBounce i:nth-child(3){ animation-delay: .3s; }

@keyframes bounceDot{
  0%, 80%, 100%{ transform: translateY(0); opacity:.35; }
  40%{ transform: translateY(-4px); opacity:1; }
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
    padding: 10px;
    /* ✅ 入力バーが fixed になるので、その分の余白を確保 */
    padding-bottom: calc(86px + env(safe-area-inset-bottom));
  }

  /* ✅ SPではinputRow中のpcOnlyが消えるので整形 */
  .inputRow {
    width: 100%;
  }

  .jumpBtn {
    right: 10px;
    bottom: calc(62px + env(safe-area-inset-bottom));
  }

  /* ✅ ここが本丸：SPでは入力バーを fixed にして bottom をキーボード分上げる */
  .chatInputWrap {
    position: fixed;
    left: 0;
    right: 0;
    bottom: var(--kb, 0px);
    z-index: 160;
    border-top: 1px solid #eee;
    background: #fff; /* 透け防止 */
    box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.06);
  }

  /* Bottom Sheet表示中は下の入力バーを隠す（入れてるなら） */
  .hiddenWhenSheet {
    display: none !important;
  }
}
       
      `}</style>
    </div>
  );
}
