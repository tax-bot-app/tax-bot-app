"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getSupabaseClient } from "../lib/supabaseClient";

type ChatMessage = { role: "user" | "assistant"; content: string };

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

type CheckoutRes = { ok: true; url: string } | { ok: false; error: string };

type Dialect = "kansai" | "standard";
type Stance = "zubatto" | "sanbo";

type ThreadItem = {
  id: string;
  title: string | null;
  created_at: string;
};

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
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// UUID v4（crypto.randomUUID が無い環境でも UUID 形式を保証）
function uuidv4(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function fmtMMDDHHmm(iso: string): string {
  // supabaseのcreated_atはUTCが多い。表示はローカルでOK（厳密は後で）
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mi}`;
}

export default function ChatPage() {
  const [input, setInput] = useState("");
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

  // checkout
  const [checkoutLoading, setCheckoutLoading] = useState(false);

  // threads
  const [threads, setThreads] = useState<ThreadItem[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [activeTitle, setActiveTitle] = useState<string>("（無題）");

  // style toggles（送信しない限り消費しない）
  const [dialect, setDialect] = useState<Dialect>("kansai");
  const [stance, setStance] = useState<Stance>("zubatto");

  const bottomRef = useRef<HTMLDivElement | null>(null);
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

  const scrollBottom = () => bottomRef.current?.scrollIntoView({ behavior: "smooth" });

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

  // threads: 一覧取得
  const refreshThreads = async (opts?: { silent?: boolean }) => {
    if (!supabase) return;
    if (!opts?.silent) setThreadsLoading(true);

    try {
      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session?.access_token) {
        setThreads([]);
        return;
      }

      // RLS前提で「自分の conversations」だけ見える
      const { data: rows, error: e2 } = await supabase
        .from("conversations")
        .select("id,title,created_at")
        .order("created_at", { ascending: false })
        .limit(50);

      if (e2) throw e2;

      setThreads((rows as any as ThreadItem[]) ?? []);
    } catch {
      // 一覧が取れない＝致命ではない。画面はそのまま。
    } finally {
      if (!opts?.silent) setThreadsLoading(false);
    }
  };

  // messages: 選択スレッドの取得
  const loadConversation = async (conversationId: string) => {
    if (!supabase) return;
    setLoading(true);

    try {
      const { data: rows, error } = await supabase
        .from("messages")
        .select("role,content,created_at")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true })
        .limit(200);

      if (error) throw error;

      const mapped: ChatMessage[] =
        (rows as any[])?.map((r) => ({ role: r.role, content: r.content })) ?? [];

      if (mapped.length === 0) {
        setMessages([{ role: "assistant", content: `${BOT}: 相談内容をどうぞ。` }]);
      } else {
        setMessages(mapped);
      }
    } catch (e: any) {
      setMessages([
        { role: "assistant", content: `${BOT}: 会話履歴の読み込みに失敗しました（${e?.message ?? String(e)}）` },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const onNewThread = () => {
    setActiveConversationId(null);
    setActiveTitle("（無題）");
    setMessages([{ role: "assistant", content: `${BOT}: 相談内容をどうぞ。` }]);
    setInput("");
  };

  const onSelectThread = async (t: ThreadItem) => {
    setActiveConversationId(t.id);
    setActiveTitle(t.title || "（無題）");
    await loadConversation(t.id);
  };

  const updateActiveTitleInList = (id: string, title: string) => {
    setThreads((prev) => prev.map((x) => (x.id === id ? { ...x, title } : x)));
  };

  const renameThread = async () => {
    if (!supabase) return;
    if (!activeConversationId) return;

    const next = window.prompt("スレッド名を入力", activeTitle === "（無題）" ? "" : activeTitle);
    if (next === null) return;

    const title = next.trim();
    if (!title) return;

    try {
      const { error } = await supabase
        .from("conversations")
        .update({ title })
        .eq("id", activeConversationId);

      if (error) throw error;

      setActiveTitle(title);
      updateActiveTitleInList(activeConversationId, title);
    } catch {
      // rename失敗は無視（あとで強化）
      showStatusMsg("スレッド名の更新に失敗");
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
          conversationId: activeConversationId,
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

      // usage update
      setPlan(json.plan ?? plan);
      setUsed(Number(json.used_talks ?? used));
      setLimit(Number(json.limit_talks ?? limit));

      // ✅ ここがactiveConversationId方式の肝
      if (json.conversation_id && json.conversation_id !== activeConversationId) {
        setActiveConversationId(json.conversation_id);

        // 送信直後は「スレ一覧にまだ居ない」ことがあるので即リフレッシュ
        await refreshThreads({ silent: true });

        // titleが未設定なら、最初の送信内容を仮タイトルにする（サーバ側もseed入れてるので基本いらんけど保険）
        const seed = text.length <= 24 ? text : text.slice(0, 24) + "…";
        setActiveTitle(seed);
      }

      setMessages((prev) => [...prev, { role: "assistant", content: `${BOT}: ${json.message}` }]);

      // スレ一覧の先頭に来るようにリフレッシュ（軽めに）
      await refreshThreads({ silent: true });
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

  // 初回：ステータス/スレ一覧/トグル復元
  useEffect(() => {
    refreshStatus({ silent: true });
    refreshThreads({ silent: true });

    try {
      const d = localStorage.getItem("sjk_dialect");
      if (d === "kansai" || d === "standard") setDialect(d);

      const s = localStorage.getItem("sjk_stance");
      if (s === "zubatto" || s === "sanbo") setStance(s);
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    scrollBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, loading]);

  // トグル保存（切替は無料：送信しない限り消費しない）
  useEffect(() => {
    try {
      localStorage.setItem("sjk_dialect", dialect);
    } catch {}
  }, [dialect]);

  useEffect(() => {
    try {
      localStorage.setItem("sjk_stance", stance);
    } catch {}
  }, [stance]);

  // 初回に「最新スレを自動で開く」：やりたければON（今回は控えめにOFF相当）
  // useEffect(() => { if (!activeConversationId && threads[0]) onSelectThread(threads[0]); }, [threads]);

  return (
    <main style={{ maxWidth: 1100, margin: "28px auto", padding: 16 }}>
      <h1 style={{ textAlign: "center", marginBottom: 14 }}>さじかげん｜税務相談</h1>

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
          {statusMsg && (
            <span style={{ marginLeft: 12, fontWeight: 700, color: "#666" }}>・{statusMsg}</span>
          )}
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

      {/* main layout */}
      <div style={{ display: "flex", gap: 12, marginTop: 14 }}>
        {/* left: thread list */}
        <aside
          style={{
            width: 300,
            minWidth: 260,
            border: "1px solid #ddd",
            borderRadius: 14,
            background: "#fff",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: 12,
              borderBottom: "1px solid #eee",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <div style={{ fontWeight: 900 }}>スレッド</div>
            <button
              onClick={onNewThread}
              style={{
                padding: "6px 10px",
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

          <div style={{ maxHeight: 520, overflowY: "auto" }}>
            {threadsLoading && (
              <div style={{ padding: 12, color: "#666" }}>読み込み中…</div>
            )}

            {!threadsLoading && threads.length === 0 && (
              <div style={{ padding: 12, color: "#666" }}>まだスレッドがありません</div>
            )}

            {threads.map((t) => {
              const active = t.id === activeConversationId;
              return (
                <div
                  key={t.id}
                  onClick={() => onSelectThread(t)}
                  style={{
                    padding: 12,
                    borderBottom: "1px solid #f2f2f2",
                    cursor: "pointer",
                    background: active ? "#f1f5ff" : "#fff",
                  }}
                >
                  <div style={{ fontWeight: 900, marginBottom: 4 }}>
                    {t.title || "（無題）"}
                  </div>
                  <div style={{ fontSize: 12, color: "#666" }}>{fmtMMDDHHmm(t.created_at)}</div>
                </div>
              );
            })}
          </div>
        </aside>

        {/* right: chat */}
        <section style={{ flex: 1 }}>
          <div
            style={{
              border: "1px solid #ddd",
              borderRadius: 14,
              padding: 12,
              background: "#fff",
            }}
          >
            {/* header row */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                marginBottom: 10,
              }}
            >
              <div style={{ fontWeight: 900 }}>
                {activeConversationId ? activeTitle : "（無題）"}
                {activeConversationId && (
                  <button
                    onClick={renameThread}
                    style={{
                      marginLeft: 10,
                      padding: "4px 8px",
                      borderRadius: 10,
                      border: "1px solid #ddd",
                      background: "#fff",
                      cursor: "pointer",
                      fontWeight: 800,
                      fontSize: 12,
                    }}
                    title="スレッド名を変更"
                  >
                    名前変更
                  </button>
                )}
              </div>

              {/* toggles */}
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <button
                  onClick={() => setDialect("kansai")}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 10,
                    border: "1px solid #ddd",
                    background: dialect === "kansai" ? "#111" : "#fff",
                    color: dialect === "kansai" ? "#fff" : "#111",
                    cursor: "pointer",
                    fontWeight: 900,
                  }}
                  title="関西弁"
                >
                  関西弁
                </button>

                <button
                  onClick={() => setDialect("standard")}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 10,
                    border: "1px solid #ddd",
                    background: dialect === "standard" ? "#111" : "#fff",
                    color: dialect === "standard" ? "#fff" : "#111",
                    cursor: "pointer",
                    fontWeight: 900,
                  }}
                  title="標準語"
                >
                  標準語
                </button>

                <button
                  onClick={() => setStance("zubatto")}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 10,
                    border: "1px solid #ddd",
                    background: stance === "zubatto" ? "#111" : "#fff",
                    color: stance === "zubatto" ? "#fff" : "#111",
                    cursor: "pointer",
                    fontWeight: 900,
                  }}
                  title="ズバっと"
                >
                  ズバっと
                </button>

                <button
                  onClick={() => setStance("sanbo")}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 10,
                    border: "1px solid #ddd",
                    background: stance === "sanbo" ? "#111" : "#fff",
                    color: stance === "sanbo" ? "#fff" : "#111",
                    cursor: "pointer",
                    fontWeight: 900,
                  }}
                  title="参謀"
                >
                  参謀
                </button>
              </div>
            </div>

            {/* messages */}
            <div
              style={{
                border: "1px solid #eee",
                borderRadius: 14,
                padding: 12,
                minHeight: 420,
                background: "#fff",
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
              <div ref={bottomRef} />
            </div>

            {/* input */}
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
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
        </section>
      </div>
    </main>
  );
}
