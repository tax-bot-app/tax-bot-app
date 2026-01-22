"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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

function nearBottom(el: HTMLElement, threshold = 80) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

/** **太字** だけ軽量対応（見出しは使わん前提） */
function renderBoldInline(text: string): ReactNode {
  // "**" で分割して奇数番目をstrong
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

/** 3パターン回答のときは決め台詞をUI側で消す（くどさ防止） */
function stripCatchphraseIfThreePatterns(content: string): string {
  const hasAttack = content.includes("🍚🥄");
  const hasDefense = content.includes("🧂🥄");
  if (!(hasAttack && hasDefense)) return content;

  const lines = content.split("\n");
  // 末尾付近にある“決め台詞”っぽい行を削る（1行だけ）
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t) continue;
    if (t.includes("とはいえども") && t.includes("遠慮なく")) {
      lines.splice(i, 1);
      break;
    }
    // 末尾から探して、別行で分割されてても拾えるように軽く補助
    if (t.includes("税務の世界") && t.includes("答えはひとつ")) {
      lines.splice(i, 1);
      break;
    }
    break;
  }
  return lines.join("\n").trimEnd();
}

function classifyLine(line: string) {
  const t = line.trimStart();
  if (t.startsWith("🥄") || t.startsWith("🍚🥄") || t.startsWith("🧂🥄")) return "headline";
  if (t.startsWith("🔎")) return "confirm";
  if (t.startsWith("⚠️")) return "warn";
  return "normal";
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

  const listRef = useRef<HTMLDivElement | null>(null);
  const msgsRef = useRef<HTMLDivElement | null>(null);

  const [autoScroll, setAutoScroll] = useState(true);

  const CONTACT_URL = process.env.NEXT_PUBLIC_CONTACT_URL || "mailto:support@example.com";

  const scrollMessagesBottom = () => {
    const el = msgsRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  };

  // ✅ セッション取得：JWT切れならrefreshを試す。ダメならnull。
  const getToken = async (): Promise<string | null> => {
    const { data, error } = await supabase.auth.getSession();
    if (!error && data.session?.access_token) return data.session.access_token;

    const refreshed = await supabase.auth.refreshSession().catch(() => null);
    const token = refreshed?.data?.session?.access_token ?? null;
    return token;
  };

  const handleAuthishError = (raw: unknown) => {
    const msg = String((raw as any)?.message || raw || "");
    const low = msg.toLowerCase();

    if (low.includes("jwt expired") || low.includes("invalid jwt") || low.includes("not logged in")) {
      setErrMsg("セッションが切れてるわ。ログインし直してな。");
      router.push("/login");
      return true;
    }
    return false;
  };

  const refreshStatus = async () => {
    setErrMsg(null);
    try {
      const token = await getToken();
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

      const okJson: Extract<StatusRes, { ok: true }> = json;
      setPlan(okJson.plan);
      setUsedTalks(okJson.used_talks);
      setLimitTalks(okJson.limit_talks);
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

          const head = lastMsg?.[0]?.content ? clamp(lastMsg[0].content, 28) : "";
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

  const loadMessages = async (conversationId: string) => {
    setErrMsg(null);
    setLoading(true);
    try {
      const token = await getToken();
      if (!token) throw new Error("Not logged in");

      const { data, error } = await supabase
        .from("messages")
        .select("id, conversation_id, role, content, created_at")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true })
        .limit(500);

      if (error) throw error;
      setMessages((data ?? []) as MessageRow[]);

      // 読み込み直後は基本下へ
      setAutoScroll(true);
      setTimeout(() => scrollMessagesBottom(), 0);
    } catch (e: any) {
      if (handleAuthishError(e)) return;
      setErrMsg(e?.message || "load messages failed");
    } finally {
      setLoading(false);
    }
  };

  const newThread = () => {
    setActiveConversationId(null);
    saveLocal("chat:activeConversationId", "");
    setMessages([]);
    setErrMsg(null);
    setInput("");
    setAutoScroll(true);
    setTimeout(() => {
      const el = msgsRef.current;
      if (el) el.scrollTop = 0;
    }, 0);
  };

  const editThreadTitle = async () => {
    if (!activeConversationId) return;
    const current = threads.find((t) => t.id === activeConversationId)?.title || "";
    const next = window.prompt("スレッドのタイトル（一覧に出る名前）", current);
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

      setThreads((prev) => prev.map((t) => (t.id === activeConversationId ? { ...t, title } : t)));
    } catch (e: any) {
      if (handleAuthishError(e)) return;
      setErrMsg(e?.message || "rename failed");
    }
  };

  const canSend = (() => {
    if (loading) return false;
    if (!limitTalks) return true; // 未読なら一旦true（サーバで弾く）
    const used = usedTalks ?? 0;
    return used < limitTalks;
  })();

  const sendMessage = async () => {
    const text = input.trim();
    if (!text) return;

    setErrMsg(null);
    setLoading(true);
    setInput("");

    const tempUser: MessageRow = {
      id: crypto.randomUUID(),
      conversation_id: activeConversationId || "temp",
      role: "user",
      content: text,
      created_at: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, tempUser]);
    setAutoScroll(true);
    setTimeout(() => scrollMessagesBottom(), 0);

    try {
      const token = await getToken();
      if (!token) throw new Error("Not logged in");

      const idempotencyKey = crypto.randomUUID();

      const body: any = {
        message: text,
        idempotencyKey,
        dialect,
        stance,
      };
      if (activeConversationId) body.conversationId = activeConversationId;

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });

      const json = (await res.json().catch(() => null)) as ChatRes | null;
      if (!json) throw new Error(`chat failed: ${res.status}`);

      if (json.ok !== true) {
        setErrMsg(json.error || `chat failed: ${res.status}`);
        return;
      }

      const okJson: Extract<ChatRes, { ok: true }> = json;

      setPlan(okJson.plan);
      setUsedTalks(okJson.used_talks);
      setLimitTalks(okJson.limit_talks);

      const newConvId = okJson.conversation_id;
      if (newConvId && isUuid(newConvId)) {
        if (!activeConversationId) {
          setActiveConversationId(newConvId);
          saveLocal("chat:activeConversationId", newConvId);

          // tempの会話IDを付け替え（表示の整合性用）
          setMessages((prev) =>
            prev.map((m) => (m.conversation_id === "temp" ? { ...m, conversation_id: newConvId } : m))
          );

          await loadThreads();
        } else {
          setThreads((prev) =>
            prev.map((t) => (t.id === activeConversationId ? { ...t, preview: clamp(text, 28) } : t))
          );
        }

        // ✅ DBを正として再読込（※二重返信防止の方針）
        await loadMessages(newConvId);
        await loadThreads();
        return;
      }

      // convId返らんケース（基本ない想定）でも、最低限だけ表示
      const tempAsst: MessageRow = {
        id: crypto.randomUUID(),
        conversation_id: activeConversationId || "temp",
        role: "assistant",
        content: okJson.message,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, tempAsst]);
      setAutoScroll(true);
      setTimeout(() => scrollMessagesBottom(), 0);
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

  useEffect(() => {
    saveLocal("chat:dialect", dialect);
  }, [dialect]);
  useEffect(() => {
    saveLocal("chat:stance", stance);
  }, [stance]);

  // メッセージ増えた時に「最下部追従（ただしユーザーが上読んでる時は邪魔しない）」
  useEffect(() => {
    const el = msgsRef.current;
    if (!el) return;
    if (autoScroll) setTimeout(() => scrollMessagesBottom(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  const renderAssistantContent = (raw: string) => {
    const content = stripCatchphraseIfThreePatterns(raw);
    const lines = content.split("\n");

    const out: ReactNode[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const kind = classifyLine(line);

      const baseStyle: React.CSSProperties = {
        margin: 0,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      };

      if (kind === "headline") {
        out.push(
          <p key={i} style={{ ...baseStyle, fontWeight: 800, fontSize: 15, marginTop: i === 0 ? 0 : 10 }}>
            {renderBoldInline(line)}
          </p>
        );
        continue;
      }

      if (kind === "confirm") {
        out.push(
          <div
            key={i}
            style={{
              marginTop: 10,
              padding: "10px 10px",
              borderRadius: 10,
              border: "1px solid #f0e3b4",
              background: "#fff7db",
            }}
          >
            <p style={{ ...baseStyle, fontWeight: 700 }}>{renderBoldInline(line)}</p>
          </div>
        );
        continue;
      }

      if (kind === "warn") {
        out.push(
          <p key={i} style={{ ...baseStyle, marginTop: 10, fontWeight: 700 }}>
            {renderBoldInline(line)}
          </p>
        );
        continue;
      }

      // 普通行
      out.push(
        <p key={i} style={{ ...baseStyle, marginTop: i === 0 ? 0 : 6, fontSize: 14 }}>
          {renderBoldInline(line)}
        </p>
      );
    }

    return out;
  };

  const renderMessages = () => {
    let lastDate = "";
    const out: ReactNode[] = [];

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
              lineHeight: 1.55,
            }}
          >
            {isUser ? (
              <div style={{ fontSize: 14, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{m.content}</div>
            ) : (
              <div style={{ fontSize: 14 }}>{renderAssistantContent(m.content)}</div>
            )}

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
    (activeConversationId && threads.find((t) => t.id === activeConversationId)?.title) || "(新規)";
  const activePreview =
    (activeConversationId && threads.find((t) => t.id === activeConversationId)?.preview) || "";

  const badge = (() => {
    if (!limitTalks) return "";
    const used = usedTalks ?? 0;
    const left = Math.max(0, limitTalks - used);
    return `プラン: ${plan} / 残り ${left} 回（${used}/${limitTalks}）`;
  })();

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#fff" }}>
      {/* header（縦圧縮） */}
      <div style={{ padding: "10px 12px 8px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 16, fontWeight: 800 }}>さじかげん｜税務相談</div>

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Link href="/settings/billing">
              <button style={{ padding: "7px 10px", borderRadius: 10, border: "1px solid #ddd" }}>
                プラン変更
              </button>
            </Link>

            <a
              href={CONTACT_URL}
              target={CONTACT_URL.startsWith("http") ? "_blank" : undefined}
              rel="noreferrer"
            >
              <button style={{ padding: "7px 10px", borderRadius: 10, border: "1px solid #ddd" }}>
                お問い合わせ
              </button>
            </a>
          </div>
        </div>

        <div style={{ marginTop: 8, display: "flex", justifyContent: "center" }}>
          <div
            style={{
              width: "min(1040px, 100%)",
              border: "1px solid #ddd",
              borderRadius: 12,
              padding: "10px 12px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 10,
            }}
          >
            <div style={{ fontWeight: 800, fontSize: 13 }}>{badge || "プラン: (loading)"}</div>
            <button
              onClick={refreshStatus}
              style={{ padding: "7px 10px", borderRadius: 10, border: "1px solid #ddd" }}
            >
              更新
            </button>
          </div>
        </div>

        {errMsg && <div style={{ marginTop: 8, color: "#b00020", fontSize: 13 }}>{errMsg}</div>}
      </div>

      {/* main（ここだけが伸びる＝縦長すぎ問題を止める） */}
      <div style={{ flex: 1, display: "flex", justifyContent: "center", padding: "0 12px 12px", minHeight: 0 }}>
        <div
          style={{
            width: "min(1040px, 100%)",
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
              width: 330, // ✅ 25号店：スレッド幅
              borderRight: "1px solid #eee",
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
            }}
          >
            <div
              style={{
                padding: 10,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                borderBottom: "1px solid #eee",
              }}
            >
              <div style={{ fontWeight: 800 }}>スレッド</div>
              <button onClick={newThread} style={{ padding: "7px 10px", borderRadius: 10, border: "1px solid #ddd" }}>
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
                minHeight: 0,
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
                      setAutoScroll(true);
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
                    <div style={{ fontWeight: 800, marginBottom: 6 }}>{t.title}</div>
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
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
            {/* chat header row（縦圧縮＋「名前変更」改善） */}
            <div
              style={{
                padding: 10,
                borderBottom: "1px solid #eee",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
              }}
            >
              <div style={{ fontWeight: 800, overflow: "hidden", minWidth: 0 }}>
                <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {activeTitle}
                </div>
                {activePreview ? (
                  <div style={{ fontSize: 12, color: "#666", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {activePreview}
                  </div>
                ) : null}
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                <button
                  onClick={editThreadTitle}
                  disabled={!activeConversationId}
                  title="一覧に出るスレッド名を変える"
                  style={{
                    padding: "7px 10px",
                    borderRadius: 10,
                    border: "1px solid #ddd",
                    opacity: activeConversationId ? 1 : 0.5,
                    cursor: activeConversationId ? "pointer" : "not-allowed",
                  }}
                >
                  ✏️ タイトル
                </button>

                <button
                  onClick={() => setDialect("kansai")}
                  style={{
                    padding: "7px 10px",
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
                    padding: "7px 10px",
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
                    padding: "7px 10px",
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
                    padding: "7px 10px",
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

            {/* message list（スクロールはここで完結） */}
            <div
              ref={msgsRef}
              onScroll={() => {
                const el = msgsRef.current;
                if (!el) return;
                setAutoScroll(nearBottom(el));
              }}
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

            {/* input（下固定） */}
            <div
              style={{
                padding: 10,
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
                    if (canSend) sendMessage();
                  }
                }}
                placeholder="相談内容を入力（Enterで送信）"
                style={{
                  flex: 1,
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid #ddd",
                }}
                disabled={!canSend}
              />
              <button
                onClick={sendMessage}
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

            <div style={{ padding: "0 10px 10px", fontSize: 12, color: "#777" }}>
              ※ 未契約/上限到達のときは送信不可。口調/モード切替は送信しない限りトークに影響しません。
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
