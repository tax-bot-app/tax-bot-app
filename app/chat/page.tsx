"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { getSupabaseClient } from "../lib/supabaseClient";

type Role = "user" | "assistant";

type ChatMessage = {
  role: Role;
  content: string;
  created_at?: string; // DB由来 or 画面側で付与
};

type ConversationRow = {
  id: string;
  summary: string | null;
  created_at: string;
  summary_updated_at: string | null;
  last_at?: string | null;
  preview?: string; // 最新メッセージ頭20文字
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
  | {
      ok: false;
      error: string;
      used_talks?: number | null;
      limit_talks?: number | null;
    };

type StatusRes =
  | { ok: true; plan: string; used_talks: number | null; limit_talks: number | null }
  | { ok: false; error: string };

type CheckoutRes = { ok: true; url: string } | { ok: false; error: string };

type Dialect = "kansai" | "standard";
type Stance = "zubatto" | "sanbo";

const BOT = "さじかげん";

const PLAN_LABEL: Record<string, string> = {
  free: "free（未契約）",
  lite: "lite",
  standard: "standard",
  enterprise: "enterprise",
};

function nowTime() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function toJstLabel(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

function toHm(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// ✅ UUID v4 生成（crypto.randomUUID が無い環境でも UUID 形式を保証）
function uuidv4(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  // RFC4122 v4
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function clip(s: string, n: number) {
  const t = (s || "").replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  return t.slice(0, n) + "…";
}

function loadLocal<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (!v) return fallback;
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

function saveLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export default function ChatPage() {
  const supabase = useMemo(() => {
    try {
      return getSupabaseClient();
    } catch (e) {
      return null;
    }
  }, []);

  // UI state
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const [sessionReady, setSessionReady] = useState(false);

  // ✅ 送信中に同じ冪等キーを保持（再送・リトライで二重カウント防止）
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  // status
  const [plan, setPlan] = useState<string>("free");
  const [used, setUsed] = useState<number>(0);
  const [limit, setLimit] = useState<number>(0);

  // status UI feedback
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string>("");

  // checkout
  const [checkoutLoading, setCheckoutLoading] = useState(false);

  // mode toggles（送信しない限り消費なし）
  const [dialect, setDialect] = useState<Dialect>("kansai");
  const [stance, setStance] = useState<Stance>("zubatto");

  // conversations
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [activeTitle, setActiveTitle] = useState<string>("（無題）");
  const [renaming, setRenaming] = useState(false);
  const [renameText, setRenameText] = useState("");

  // messages（右ペイン）
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", content: `${BOT}: 相談内容をどうぞ。` },
  ]);

  // refs
  const msgAreaRef = useRef<HTMLDivElement | null>(null);
  const statusMsgTimer = useRef<number | null>(null);

  const CONTACT_URL =
    process.env.NEXT_PUBLIC_CONTACT_URL ||
    "mailto:support@gladplan.com?subject=%E3%81%95%E3%81%98%E3%81%8B%E3%81%92%E3%82%93%20%E3%81%8A%E5%95%8F%E3%81%84%E5%90%88%E3%82%8F%E3%81%9B";

  const scrollMessagesBottom = () => {
    const el = msgAreaRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  const showStatusMsg = (msg: string) => {
    setStatusMsg(msg);
    if (statusMsgTimer.current) window.clearTimeout(statusMsgTimer.current);
    statusMsgTimer.current = window.setTimeout(() => {
      setStatusMsg("");
      statusMsgTimer.current = null;
    }, 2500);
  };

  // ---- auth/status ----
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

  // ---- conversations ----
  const loadConversations = async () => {
    if (!supabase) return;
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session?.access_token) return;

    // conversations（最新順）
    const { data: convs, error: convErr } = await supabase
      .from("conversations")
      .select("id, summary, created_at, summary_updated_at")
      .order("created_at", { ascending: false })
      .limit(50);

    if (convErr) return;

    const base = (convs ?? []) as ConversationRow[];
    if (base.length === 0) {
      setConversations([]);
      return;
    }

    // 最新メッセージ頭20文字を付与（inでまとめて取り、クライアントで「最初に見つかった=最新」を採用）
    const ids = base.map((c) => c.id);

    const { data: msgs } = await supabase
      .from("messages")
      .select("conversation_id, content, created_at")
      .in("conversation_id", ids)
      .order("created_at", { ascending: false })
      .limit(500);

    const latestMap = new Map<string, { preview: string; last_at: string }>();
    for (const m of msgs ?? []) {
      const cid = (m as any).conversation_id as string;
      if (!latestMap.has(cid)) {
        latestMap.set(cid, {
          preview: clip(String((m as any).content ?? ""), 20),
          last_at: String((m as any).created_at ?? ""),
        });
      }
    }

    const merged = base.map((c) => {
      const hit = latestMap.get(c.id);
      return {
        ...c,
        preview: hit?.preview ?? "",
        last_at: hit?.last_at ?? null,
      };
    });

    // “最後に動いた順”に並べ替え（last_atが無ければcreated_at）
    merged.sort((a, b) => {
      const aa = new Date(a.last_at || a.created_at).getTime();
      const bb = new Date(b.last_at || b.created_at).getTime();
      return bb - aa;
    });

    setConversations(merged);

    // active が未設定なら一番上を選択（ただし「新規下書き中」= activeConversationId=null の時は触らない）
    if (!activeConversationId) return;
  };

  const loadMessages = async (conversationId: string) => {
    if (!supabase) return;

    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session?.access_token) return;

    const { data: rows, error: msgErr } = await supabase
      .from("messages")
      .select("role, content, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(500);

    if (msgErr) return;

    const list = (rows ?? []).map((r: any) => ({
      role: r.role as Role,
      content: String(r.content ?? ""),
      created_at: String(r.created_at ?? ""),
    }));

    // 空なら初期メッセを入れる
    if (list.length === 0) {
      setMessages([{ role: "assistant", content: `${BOT}: 相談内容をどうぞ。` }]);
    } else {
      // assistant表示を既存仕様に合わせる（「さじかげん: 」を付ける）
      const normalized = list.map((m) =>
        m.role === "assistant" && !m.content.startsWith(`${BOT}:`)
          ? { ...m, content: `${BOT}: ${m.content}` }
          : m
      );
      setMessages(normalized);
    }

    // タイトル表示
    const c = conversations.find((x) => x.id === conversationId);
    setActiveTitle(c?.summary?.trim() ? c.summary! : "（無題）");

    setTimeout(scrollMessagesBottom, 0);
  };

  const selectConversation = async (c: ConversationRow) => {
    setActiveConversationId(c.id);
    setActiveTitle(c.summary?.trim() ? c.summary! : "（無題）");
    setRenaming(false);
    setRenameText("");
    await loadMessages(c.id);
  };

  const newDraftThread = () => {
    // ✅ DBは作らない。送信した瞬間に route.ts が conversation を作ってくれる
    setActiveConversationId(null);
    setActiveTitle("（新規）");
    setRenaming(false);
    setRenameText("");
    setMessages([{ role: "assistant", content: `${BOT}: 相談内容をどうぞ。` }]);
    setTimeout(scrollMessagesBottom, 0);
  };

  const renameActive = async () => {
    if (!supabase) return;
    if (!activeConversationId) {
      showStatusMsg("まだスレッドが作成されてません（送信後に名前変更できます）");
      setRenaming(false);
      return;
    }
    const t = renameText.trim();
    if (!t) {
      setRenaming(false);
      return;
    }

    const { error } = await supabase
      .from("conversations")
      .update({ summary: t, summary_updated_at: new Date().toISOString() })
      .eq("id", activeConversationId);

    if (error) {
      showStatusMsg("名前変更に失敗しました");
      setRenaming(false);
      return;
    }

    // 画面反映
    setActiveTitle(t);
    setConversations((prev) =>
      prev.map((c) => (c.id === activeConversationId ? { ...c, summary: t } : c))
    );
    setRenaming(false);
    showStatusMsg("名前を変更しました");
  };

  // ---- checkout ----
  const startCheckout = async (targetPlan: "lite" | "standard" | "enterprise") => {
    if (!supabase) return;

    setCheckoutLoading(true);
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session?.access_token) {
        window.location.href = "/login";
        return;
      }

      const res = await fetch("/api/create-checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${data.session.access_token}`,
        },
        body: JSON.stringify({ plan: targetPlan }),
      });

      const json = (await res.json().catch(() => null)) as CheckoutRes | null;

      if (!json) throw new Error("create-checkout: empty response");
      if (!json.ok) throw new Error(json.error || "create-checkout failed");
      if (!json.url) throw new Error("create-checkout: url missing");

      window.location.href = json.url;
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `${BOT}: 決済に進めません（${e?.message ?? String(e)}）` },
      ]);
    } finally {
      setCheckoutLoading(false);
    }
  };

  // ---- send ----
  const handleSend = async () => {
    if (!supabase) return;
    const text = input.trim();
    if (!text || loading) return;

    const idempotencyKey = pendingKey ?? uuidv4();
    setPendingKey(idempotencyKey);

    setInput("");
    setLoading(true);

    const nowIso = new Date().toISOString();
    setMessages((prev) => [...prev, { role: "user", content: text, created_at: nowIso }]);

    try {
      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session?.access_token) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `${BOT}: ログインが必要です。`, created_at: new Date().toISOString() },
        ]);
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
          conversationId: activeConversationId, // ✅ ここが activeConversationId 方式
          dialect,
          stance,
        }),
      });

      const json = (await res.json().catch(() => null)) as ChatRes | null;

      if (!json) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `${BOT}: 返答の取得に失敗しました（空レスポンス）`, created_at: new Date().toISOString() },
        ]);
        return;
      }

      if (!json.ok) {
        const err = json.error || "error";
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `${BOT}: ${err}`, created_at: new Date().toISOString() },
        ]);
        await refreshStatus({ silent: true });
        return;
      }

      setPlan(json.plan ?? plan);
      setUsed(Number(json.used_talks ?? used));
      setLimit(Number(json.limit_talks ?? limit));

      // ✅ 初回送信（draft）ならここで conversation_id が返る
      if (!activeConversationId && json.conversation_id) {
        setActiveConversationId(json.conversation_id);
      }

      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `${BOT}: ${json.message}`, created_at: new Date().toISOString() },
      ]);

      // スレッド一覧を更新（最新メッセ反映）
      await loadConversations();

      // active を確定した後、DBの正しい created_at を取り直して整える（表示の安定）
      if (json.conversation_id) {
        await loadMessages(json.conversation_id);
      }
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `${BOT}: 通信エラー（${e?.message ?? String(e)}）`, created_at: new Date().toISOString() },
      ]);
    } finally {
      setLoading(false);
      setPendingKey(null);
      await refreshStatus({ silent: true });
      setTimeout(scrollMessagesBottom, 0);
    }
  };

  // ---- derived ----
  const remaining = Math.max(0, (limit || 0) - (used || 0));
  const low = limit > 0 && remaining <= 2;
  const zero = limit > 0 && remaining <= 0;

  // ---- effects ----
  useEffect(() => {
    // 初期：モード復元
    const d = loadLocal<Dialect>("chat:dialect", "kansai");
    const s = loadLocal<Stance>("chat:stance", "zubatto");
    setDialect(d);
    setStance(s);
  }, []);

  useEffect(() => {
    saveLocal("chat:dialect", dialect);
  }, [dialect]);

  useEffect(() => {
    saveLocal("chat:stance", stance);
  }, [stance]);

  useEffect(() => {
    refreshStatus({ silent: true });
    loadConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setTimeout(scrollMessagesBottom, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, loading]);

  // ---- render helpers ----
  const renderMessages = () => {
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
                color: "#666",
                background: "#f3f4f6",
                border: "1px solid #eee",
                padding: "4px 10px",
                borderRadius: 999,
              }}
            >
              {date}
            </div>
          </div>
        );
      }

      const isUser = m.role === "user";
      const bubbleText = isUser ? `あなた: ${m.content}` : m.content;

      out.push(
        <div
          key={`m-${i}`}
          style={{
            display: "flex",
            justifyContent: isUser ? "flex-end" : "flex-start",
            margin: "8px 0",
          }}
        >
          <div
            style={{
              maxWidth: "84%",
              padding: "10px 12px",
              borderRadius: 12,
              background: isUser ? "#f1f5ff" : "#f6f6f6",
              border: "1px solid #eee",
              whiteSpace: "pre-wrap",
              lineHeight: 1.55,
            }}
          >
            <div>{bubbleText}</div>
            {m.created_at && (
              <div style={{ marginTop: 6, fontSize: 11, color: "#888", textAlign: isUser ? "right" : "left" }}>
                {toHm(m.created_at)}
              </div>
            )}
          </div>
        </div>
      );
    });

    return out;
  };

  return (
    <main style={{ maxWidth: 1100, margin: "18px auto", padding: 16 }}>
      {/* top header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <h1 style={{ textAlign: "center", margin: 0, flex: 1 }}>さじかげん｜税務相談</h1>

        <div style={{ display: "flex", gap: 10, flexShrink: 0 }}>
          <Link
            href="/settings/billing"
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid #ddd",
              background: "#fff",
              fontWeight: 800,
              textDecoration: "none",
              color: "#111",
            }}
          >
            プラン変更
          </Link>

          <a
            href={CONTACT_URL}
            target={CONTACT_URL.startsWith("http") ? "_blank" : undefined}
            rel={CONTACT_URL.startsWith("http") ? "noreferrer" : undefined}
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid #ddd",
              background: "#fff",
              fontWeight: 800,
              textDecoration: "none",
              color: "#111",
            }}
          >
            お問い合わせ
          </a>
        </div>
      </div>

      {/* status bar */}
      <div
        style={{
          marginTop: 12,
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

      {zero && (
        <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            onClick={() => startCheckout("lite")}
            disabled={checkoutLoading}
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid #ddd",
              background: "#fff",
              cursor: checkoutLoading ? "not-allowed" : "pointer",
              fontWeight: 800,
            }}
          >
            Liteで開始
          </button>
          <button
            onClick={() => startCheckout("standard")}
            disabled={checkoutLoading}
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid #ddd",
              background: "#fff",
              cursor: checkoutLoading ? "not-allowed" : "pointer",
              fontWeight: 800,
            }}
          >
            Standardで開始
          </button>
          <button
            onClick={() => startCheckout("enterprise")}
            disabled={checkoutLoading}
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid #ddd",
              background: "#fff",
              cursor: checkoutLoading ? "not-allowed" : "pointer",
              fontWeight: 800,
            }}
          >
            Enterpriseへ
          </button>
          {checkoutLoading && <div style={{ alignSelf: "center", color: "#666" }}>決済ページへ移動中…</div>}
        </div>
      )}

      {/* main split area */}
      <div
        style={{
          marginTop: 12,
          border: "1px solid #ddd",
          borderRadius: 14,
          background: "#fff",
          padding: 12,
          height: "calc(100vh - 220px)", // ✅ ここが肝：画面内に収める
          minHeight: 520,
          display: "grid",
          gridTemplateColumns: "320px 1fr",
          gap: 12,
        }}
      >
        {/* left: threads */}
        <div
          style={{
            border: "1px solid #eee",
            borderRadius: 12,
            padding: 10,
            display: "flex",
            flexDirection: "column",
            minHeight: 0, // ✅ overflow有効化の必須条件
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <div style={{ fontWeight: 900 }}>スレッド</div>
            <button
              onClick={newDraftThread}
              style={{
                padding: "8px 12px",
                borderRadius: 10,
                border: "1px solid #ddd",
                background: "#fff",
                cursor: "pointer",
                fontWeight: 800,
              }}
            >
              新規
            </button>
          </div>

          <div
            style={{
              marginTop: 10,
              overflowY: "auto",
              minHeight: 0,
              paddingRight: 4,
            }}
          >
            {conversations.length === 0 && (
              <div style={{ color: "#666", fontSize: 13, padding: 10 }}>
                まだスレッドがありません。
              </div>
            )}

            {conversations.map((c) => {
              const active = c.id === activeConversationId;
              const title = c.summary?.trim() ? c.summary! : "（無題）";
              const when = c.last_at || c.created_at;
              return (
                <button
                  key={c.id}
                  onClick={() => selectConversation(c)}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    border: active ? "2px solid #c7d2fe" : "1px solid #eee",
                    background: active ? "#eef2ff" : "#fff",
                    borderRadius: 12,
                    padding: "10px 10px",
                    cursor: "pointer",
                    marginBottom: 10,
                  }}
                >
                  <div style={{ fontWeight: 900, marginBottom: 4 }}>{title}</div>
                  <div style={{ fontSize: 12, color: "#666" }}>{toJstLabel(when)} {toHm(when)}</div>
                  {!!c.preview && (
                    <div style={{ fontSize: 12, color: "#444", marginTop: 6 }}>
                      {c.preview}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* right: chat */}
        <div
          style={{
            border: "1px solid #eee",
            borderRadius: 12,
            padding: 10,
            display: "flex",
            flexDirection: "column",
            minHeight: 0, // ✅ overflow有効化
          }}
        >
          {/* header row */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
              <div style={{ fontWeight: 900, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 320 }}>
                {activeConversationId ? activeTitle : "（新規）"}
              </div>

              {/* rename */}
              {!renaming ? (
                <button
                  onClick={() => {
                    setRenaming(true);
                    setRenameText(activeConversationId ? activeTitle : "");
                  }}
                  style={{
                    padding: "7px 10px",
                    borderRadius: 10,
                    border: "1px solid #ddd",
                    background: "#fff",
                    cursor: "pointer",
                    fontWeight: 800,
                  }}
                >
                  名前変更
                </button>
              ) : (
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    value={renameText}
                    onChange={(e) => setRenameText(e.target.value)}
                    placeholder="スレッド名"
                    style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd", width: 220 }}
                  />
                  <button
                    onClick={renameActive}
                    style={{
                      padding: "8px 10px",
                      borderRadius: 10,
                      border: "1px solid #ddd",
                      background: "#fff",
                      cursor: "pointer",
                      fontWeight: 800,
                    }}
                  >
                    保存
                  </button>
                  <button
                    onClick={() => setRenaming(false)}
                    style={{
                      padding: "8px 10px",
                      borderRadius: 10,
                      border: "1px solid #eee",
                      background: "#fafafa",
                      cursor: "pointer",
                      fontWeight: 800,
                    }}
                  >
                    取消
                  </button>
                </div>
              )}
            </div>

            {/* mode toggles */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <button
                onClick={() => setDialect("kansai")}
                style={{
                  padding: "8px 10px",
                  borderRadius: 10,
                  border: "1px solid #ddd",
                  background: dialect === "kansai" ? "#111" : "#fff",
                  color: dialect === "kansai" ? "#fff" : "#111",
                  cursor: "pointer",
                  fontWeight: 900,
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
                  cursor: "pointer",
                  fontWeight: 900,
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
                  cursor: "pointer",
                  fontWeight: 900,
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
                  cursor: "pointer",
                  fontWeight: 900,
                }}
              >
                参謀
              </button>
            </div>
          </div>

          {/* messages area (scrollable) */}
          <div
            ref={msgAreaRef}
            style={{
              marginTop: 10,
              border: "1px solid #eee",
              borderRadius: 12,
              padding: 12,
              flex: 1,
              overflowY: "auto", // ✅ ここで右だけスクロール
              minHeight: 0,
              background: "#fff",
            }}
          >
            {renderMessages()}
            {loading && <div style={{ margin: "10px 0", color: "#666" }}>{BOT}: （考え中）</div>}
          </div>

          {/* input row */}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
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
                fontWeight: 900,
                minWidth: 84,
              }}
            >
              送信
            </button>
          </div>

          <p style={{ color: "#666", fontSize: 12, marginTop: 8 }}>
            ※ 未契約/上限到達のときは送信不可（無駄打ち防止）。口調/モード切替は送信しない限りトーク消費しません。
          </p>
        </div>
      </div>
    </main>
  );
}
