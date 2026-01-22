"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from "react";
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

// 3パターン回答の時は決め台詞をUI側で消す（くどさ防止）
// ※サーバでも抑止するが、UIは保険として残す
function stripCatchphraseIfThreePatterns(content: string): string {
  const hasAttack = content.includes("🍚");
  const hasDefense =
    content.includes("🧂守り") ||
    content.includes("🧂🥄") ||
    content.includes("🧂 守り");

  if (!(hasAttack && hasDefense)) return content;

  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t) continue;

    // catchphraseっぽい最後の1行を落とす（方言差分があっても拾えるように）
    if (t.includes("とはいえ") || (t.includes("税務の世界") && t.includes("答え"))) {
      lines.splice(i, 1);
    }
    break;
  }
  return lines.join("\n").trimEnd();
}

// ✅ タイトル行だけ強調（色はここだけ）
function lineStyle(line: string): CSSProperties {
  const t = line.trimStart();
  const isTitle =
    t.startsWith("🧂") || t.startsWith("🍚") || t.startsWith("🧂🥄") || t.startsWith("🍚🥄");
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

export default function ChatClient() {
  const supabase = useMemo(() => getSupabaseClient(), []);
  const router = useRouter();

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

  const msgsRef = useRef<HTMLDivElement | null>(null);

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
    el.scrollTop = el.scrollHeight;
  };

  const getToken = async (): Promise<string | null> => {
    const { data, error } = await supabase.auth.getSession();
    if (!error && data.session?.access_token) return data.session.access_token;

    const refreshed = await supabase.auth.refreshSession().catch(() => null);
    return refreshed?.data?.session?.access_token ?? null;
  };

  const handleAuthishError = (raw: unknown) => {
    const msg = String((raw as any)?.message || raw || "");
    const low = msg.toLowerCase();
    if (low.includes("jwt expired") || low.includes("invalid jwt") || low.includes("not logged in")) {
      setErrMsg("セッション切れてる。ログインし直してな。");
      router.push("/login");
      return true;
    }
    return false;
  };

  const refreshStatus = async () => {
    setErrMsg(null);
    try {
      const token = await getToken();
      if (!token) return;

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
      if (handleAuthishError(e)) return;
      setErrMsg(e?.message || "status failed");
    }
  };

  const loadThreads = async () => {
    setErrMsg(null);
    try {
      const token = await getToken();
      if (!token) return;

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

      const previews = await Promise.all(
        base.map(async (t) => {
          const { data: lastMsg } = await supabase
            .from("messages")
            .select("content, created_at")
            .eq("conversation_id", t.id)
            .order("created_at", { ascending: false })
            .limit(1);

          const head = lastMsg?.[0]?.content ? clamp(lastMsg[0].content, 24) : "";
          return { ...t, preview: head };
        })
      );

      previews.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setThreads(previews);

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
      if (handleAuthishError(e)) return;
      setErrMsg(e?.message || "load threads failed");
    }
  };

  // silent=true の時は loading を触らない（送信中にfalseへ戻る事故を防ぐ）
  const loadMessages = async (conversationId: string, opts?: { silent?: boolean }): Promise<MessageRow[]> => {
    setErrMsg(null);
    if (!opts?.silent) setLoading(true);

    try {
      const token = await getToken();
      if (!token) throw new Error("Not logged in");

      const { data, error } = await supabase
        .from("messages")
        .select("id, conversation_id, role, content, created_at")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true })
        .limit(700);

      if (error) throw error;

      const normalized = normalizeMessages(data as any[]);
      setMessages(normalized);
      setTimeout(scrollBottom, 0);
      return normalized;
    } catch (e: any) {
      if (handleAuthishError(e)) return [];
      setErrMsg(e?.message || "load messages failed");
      return [];
    } finally {
      if (!opts?.silent) setLoading(false);
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
      const { error } = await supabase
        .from("conversations")
        .update({ summary: title, summary_updated_at: new Date().toISOString() })
        .eq("id", activeConversationId);

      if (error) throw error;

      setThreads((prev) => prev.map((t) => (t.id === activeConversationId ? { ...t, title } : t)));
    } catch (e: any) {
      if (handleAuthishError(e)) return;
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
    setInput("");

    // tempUser 即表示（右側）
    const tempUser: MessageRow = {
      id: crypto.randomUUID(),
      conversation_id: activeConversationId || "temp",
      role: "user",
      content: text,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempUser]);
    setTimeout(scrollBottom, 0);

    try {
      const token = await getToken();
      if (!token) throw new Error("Not logged in");

      const idempotencyKey = crypto.randomUUID();
      const body: any = { message: text, idempotencyKey, dialect, stance };
      if (activeConversationId) body.conversationId = activeConversationId;

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
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

      const convId =
        json.conversation_id && isUuid(json.conversation_id) ? json.conversation_id : null;

      if (convId && !activeConversationId) {
        setActiveConversationId(convId);
        saveLocal("chat:activeConversationId", convId);
        setMessages((prev) =>
          prev.map((m) =>
            m.conversation_id === "temp" ? { ...m, conversation_id: convId } : m
          )
        );
      }

      const effectiveConvId = convId || activeConversationId;

      await loadThreads();

      // DBを正として再読込（原則）
      let loaded: MessageRow[] = [];
      if (effectiveConvId) loaded = await loadMessages(effectiveConvId, { silent: true });

      // ただし、DB書き込みが何かで落ちた時に「運用テストが成立しない」を防ぐ保険
      // ＝ loaded に今回の user/assistant が見当たらなければ、UI側で“欠けた分だけ”補完する
      if (effectiveConvId) {
        const wantUser = text.trim();
        const wantAsst = String(json.message ?? "").trim();

        const hasUser = loaded.some(
          (m) => m.role === "user" && m.content.trim() === wantUser
        );
        const hasAsst = loaded.some(
          (m) => m.role === "assistant" && m.content.trim() === wantAsst
        );

        if (!hasUser || !hasAsst) {
          setMessages((prev) => {
            // 直前の表示をベースに、重複しない範囲で足す
            const base = [...(loaded.length ? loaded : prev)];

            const next = [...base];
            if (!hasUser) {
              next.push({
                id: crypto.randomUUID(),
                conversation_id: effectiveConvId,
                role: "user",
                content: wantUser,
                created_at: new Date().toISOString(),
              });
            }
            if (!hasAsst) {
              next.push({
                id: crypto.randomUUID(),
                conversation_id: effectiveConvId,
                role: "assistant",
                content: wantAsst,
                created_at: new Date().toISOString(),
              });
            }
            // created_at順に一応整列（保険）
            next.sort((a, b) => a.created_at.localeCompare(b.created_at));
            return next;
          });
          setTimeout(scrollBottom, 0);
        }
      }
    } catch (e: any) {
      if (handleAuthishError(e)) return;
      setErrMsg(String(e?.message || "send failed"));
    } finally {
      setLoading(false);
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

  const activeTitle =
    (activeConversationId && threads.find((t) => t.id === activeConversationId)?.title) ||
    "(新規)";
    const canRename = Boolean(activeConversationId);

    

  const badge = (() => {
    if (!limitTalks) return "";
    const used = usedTalks ?? 0;
    const left = Math.max(0, limitTalks - used);
    return `プラン: ${plan} / 残り ${left} 回（${used}/${limitTalks}）`;
  })();

  // ✅ 横はできるだけ広げる
  const ROOT_W = "min(1400px, 100%)";
  const THREAD_W = 330;

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "#fff",
        position: "relative",
      }}
    >
      {/* header（クリック奪い対策：上に固定） */}
      <div style={{ padding: "10px 16px", position: "relative", zIndex: 30, pointerEvents: "auto" }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <div style={{ flex: 1 }} />
          <div style={{ textAlign: "center", fontWeight: 900, fontSize: 18 }}>
            さじかげん 🍚🥄｜税務相談{" "}
            <span style={{ fontSize: 12, fontWeight: 700, color: "#666" }}>
              ～あなたの欲しい ちょうどいい さじかげん～
            </span>
          </div>
          <div style={{ flex: 1, display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <Link href="/settings/billing" style={LINK_BTN}>
              プラン変更
            </Link>
            <a
              href={CONTACT_URL}
              style={LINK_BTN}
              target={CONTACT_URL.startsWith("http") ? "_blank" : undefined}
              rel="noreferrer"
            >
              お問い合わせ
            </a>
          </div>
        </div>

        <div style={{ marginTop: 10, display: "flex", justifyContent: "center" }}>
          <div
            style={{
              width: ROOT_W,
              border: "1px solid #ddd",
              borderRadius: 12,
              padding: "10px 12px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 10,
            }}
          >
            <div style={{ fontWeight: 800 }}>{badge || "プラン: (loading)"}</div>
            <button type="button" onClick={refreshStatus} style={BTN}>
              更新
            </button>
          </div>
        </div>

        {errMsg && <div style={{ marginTop: 8, color: "#b00020", fontSize: 13 }}>{errMsg}</div>}
      </div>

      {/* main */}
      <div
        style={{
          flex: 1,
          display: "flex",
          justifyContent: "center",
          padding: "0 16px 16px",
          minHeight: 0,
          position: "relative",
          zIndex: 10,
        }}
      >
        <div
          style={{
            width: ROOT_W,
            border: "1px solid #ddd",
            borderRadius: 12,
            display: "flex",
            overflow: "hidden",
            minHeight: 0,
          }}
        >
          {/* threads */}
          <div
            style={{
              width: THREAD_W,
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
                position: "relative",
                zIndex: 5,
              }}
            >
              <div style={{ fontWeight: 900 }}>スレッド</div>
              <button type="button" onClick={newThread} style={BTN}>
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
                      pointerEvents: "auto",
                    }}
                  >
                    <div style={{ fontWeight: 900, marginBottom: 6 }}>{t.title}</div>
                    <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>
                      {toJstLabel(t.createdAt)} {toHm(t.createdAt)}
                    </div>
                    <div style={{ fontSize: 12, color: t.preview ? "#333" : "#999" }}>
                      {t.preview || "(プレビューなし)"}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* chat */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
            {/* toolbar（クリック奪い対策：上に固定） */}
            <div
              style={{
                padding: 12,
                borderBottom: "1px solid #eee",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
                position: "relative",
                zIndex: 20,
                pointerEvents: "auto",
                background: "#fff",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
  <div style={{ fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
    {activeTitle}
  </div>
  <div style={{ fontSize: 12, color: "#666", whiteSpace: "nowrap" }}>
    （{dialect}/{stance}）
  </div>
</div>


              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
               <button
  type="button"
  onPointerDown={(e) => {
    e.preventDefault();
    if (canRename) renameThread();
  }}
  onTouchStart={(e) => {
    e.preventDefault();
    if (canRename) renameThread();
  }}
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



                <button
  type="button"
  onPointerDown={(e) => { e.preventDefault(); setDialect("kansai"); }}
  onTouchStart={(e) => { e.preventDefault(); setDialect("kansai"); }}
  style={toggleBtn(dialect === "kansai")}
>
  関西弁
</button>

                <button
  type="button"
  onPointerDown={(e) => { e.preventDefault(); setDialect("standard"); }}
  onTouchStart={(e) => { e.preventDefault(); setDialect("standard"); }}
  style={toggleBtn(dialect === "standard")}
>
  標準語
</button>

                <button
  type="button"
  onPointerDown={(e) => { e.preventDefault(); setStance("zubatto"); }}
  onTouchStart={(e) => { e.preventDefault(); setStance("zubatto"); }}
  style={toggleBtn(stance === "zubatto")}
>
  ズバっと
</button>

                <button
  type="button"
  onPointerDown={(e) => { e.preventDefault(); setStance("sanbo"); }}
  onTouchStart={(e) => { e.preventDefault(); setStance("sanbo"); }}
  style={toggleBtn(stance === "sanbo")}
>
  参謀
</button>

              </div>
            </div>

            {/* messages（ここがスクロール領域） */}
            <div
              ref={msgsRef}
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: "auto",
                padding: "12px 14px",
                background: "#fff",
                position: "relative",
                zIndex: 1,
              }}
            >
              {messages.map((m, idx) => {
                const role = normalizeRole((m as any).role);
                const isUser = role === "user"; // ✅ 絶対基準
                const raw = String(m.content ?? "");
                const content = isUser ? raw : stripCatchphraseIfThreePatterns(raw);

                return (
                  <div
                    key={m.id ?? idx}
                    style={{
                      display: "flex",
                      justifyContent: isUser ? "flex-end" : "flex-start",
                      margin: "10px 0",
                    }}
                  >
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
                        <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.6 }}>
                          {content}
                        </div>
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

                      <div style={{ fontSize: 11, color: "#777", marginTop: 8, textAlign: "right" }}>
                        {toHm(m.created_at)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* input（常に最下段） */}
            <div
              style={{
                padding: 12,
                borderTop: "1px solid #eee",
                display: "flex",
                gap: 10,
                alignItems: "center",
                background: "#fff",
                position: "relative",
                zIndex: 20,
              }}
            >
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
                onClick={sendMessage}
                disabled={!canSend}
                style={{
                  padding: "10px 16px",
                  borderRadius: 10,
                  border: "1px solid #ddd",
                  background: "#fff",
                  cursor: !canSend ? "not-allowed" : "pointer",
                  opacity: !canSend ? 0.6 : 1,
                  pointerEvents: !canSend ? "none" : "auto",
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
    </div>
  );
}
