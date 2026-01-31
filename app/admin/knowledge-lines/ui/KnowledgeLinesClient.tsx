"use client";

import { useEffect, useMemo, useState } from "react";
import { getSupabaseClient } from "@/app/lib/supabaseClient";

type Role = "user" | "internal";
type Stance = "attack" | "defense";
type Lens = "amount" | "substance" | "system";

type LineRow = {
  id: string;
  topic: string;
  stance: Stance;
  lens: Lens;
  role: Role;
  text: string;
  priority: number;
  is_active: boolean;
  created_at?: string;
};

type QaRow = {
  id: string;
  kind: "qa";
  topic: string;
  title: string;
  content: string;
  priority: number;
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
};

type ApiListLinesRes = { ok: true; rows: LineRow[] } | { ok: false; error: string };
type ApiRowLinesRes = { ok: true; row: LineRow } | { ok: false; error: string };

type ApiListQaRes = { ok: true; rows: QaRow[] } | { ok: false; error: string };
type ApiRowQaRes = { ok: true; row: QaRow } | { ok: false; error: string };

// ===== Debug logs =====
type DebugPath = "followup_lines" | "followup_kb" | "followup_fallback" | "normal_llm";
type PickedQaMeta = { id: string; title: string; priority: number; topic: string };
type PickedLineMeta = { id: string; topic: string; lens: Lens; stance: Stance; priority: number; role?: Role };
type DebugMeta = {
  picked_qa?: PickedQaMeta[];
  picked_lines?: PickedLineMeta[];
  borrowed_prev_topic?: boolean;
  [k: string]: any;
};
type DebugRow = {
  id: string;
  created_at: string;
  user_id: string;
  conversation_id: string | null;
  message_head: string;
  topics_now: string[];
  inferred_topic: string;
  lens: Lens;
  followup: boolean;
  shifted: boolean;
  path: DebugPath;
  used_knowledge: boolean;
  used_lines_pick: boolean;
  followup_phase: boolean;
  followup_explicit: boolean;
  line_request: boolean;
  force_normal_answer: boolean;
  meta: DebugMeta;
};
type ApiListDebugRes = { ok: true; rows: DebugRow[] } | { ok: false; error: string };

function uniq(xs: string[]) {
  return Array.from(new Set(xs.filter(Boolean))).sort((a, b) => a.localeCompare(b, "ja"));
}

function TabButton(props: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={props.onClick}
      style={{
        padding: "8px 12px",
        borderRadius: 10,
        border: "1px solid #ddd",
        background: props.active ? "#111" : "#fff",
        color: props.active ? "#fff" : "#111",
        fontWeight: 700,
      }}
    >
      {props.children}
    </button>
  );
}

// ★ 横スクロール用の共通ラッパー（スマホ/PC共通）
function TableScroller(props: { children: React.ReactNode }) {
  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 8, overflow: "hidden" }}>
      <div style={{ overflowX: "auto", overflowY: "hidden", WebkitOverflowScrolling: "touch", maxWidth: "100%" }}>
        <div style={{ minWidth: 1180 }}>{props.children}</div>
      </div>
    </div>
  );
}

function Chip(props: { label: string; tone?: "ok" | "ng" | "muted" }) {
  const tone = props.tone ?? "muted";
  const bg = tone === "ok" ? "#f6fff6" : tone === "ng" ? "#fff6f6" : "#f6f6f6";
  return (
    <span style={{ padding: "2px 8px", borderRadius: 999, border: "1px solid #ddd", background: bg, whiteSpace: "nowrap" }}>
      {props.label}
    </span>
  );
}

export default function KnowledgeLinesClient() {
  const supabase = useMemo(() => getSupabaseClient(), []);
  const [tab, setTab] = useState<"lines" | "qa" | "debug">("lines");

  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function tokenOrThrow(): Promise<string> {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    const t = data.session?.access_token;
    if (!t) throw new Error("Not logged in");
    return t;
  }

  async function apiFetch(path: string, init?: RequestInit) {
    const token = await tokenOrThrow();
    return fetch(path, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
  }

  // ===== CSV download helper (Authorization付きでBlob DL) =====
  async function downloadCsv(apiPath: string, qs: URLSearchParams, filenameBase: string) {
    setLoading(true);
    setMsg(null);
    try {
      qs.set("format", "csv");
      const token = await tokenOrThrow();

      const res = await fetch(`${apiPath}?${qs.toString()}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`CSV download failed: ${res.status} ${t}`);
      }

      // 念のため text で受ける（API実装によっては text/csv）
      const text = await res.text();
      const blob = new Blob([text], { type: "text/csv;charset=utf-8" });

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${filenameBase}_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setMsg(e?.message ?? "csv download failed");
    } finally {
      setLoading(false);
    }
  }

  // =========================
  // Lines tab state
  // =========================
  const [lineRows, setLineRows] = useState<LineRow[]>([]);
  const [fTopic, setFTopic] = useState("");
  const [fLens, setFLens] = useState("");
  const [fStance, setFStance] = useState("");
  const [fActive, setFActive] = useState(""); // "", "true", "false"
  const [fRole, setFRole] = useState(""); // "", "user", "internal"

  const [editingLine, setEditingLine] = useState<LineRow | null>(null);
  const [isNewLine, setIsNewLine] = useState(false);

  const lineTopics = useMemo(() => uniq(lineRows.map((r) => r.topic)), [lineRows]);

  async function loadLines() {
    setLoading(true);
    setMsg(null);
    try {
      const qs = new URLSearchParams();
      if (fTopic) qs.set("topic", fTopic);
      if (fLens) qs.set("lens", fLens);
      if (fStance) qs.set("stance", fStance);
      if (fActive) qs.set("active", fActive);
      if (fRole) qs.set("role", fRole);

      const res = await apiFetch(`/api/admin/knowledge-lines?${qs.toString()}`);
      const json = (await res.json()) as ApiListLinesRes;
      if (!json.ok) throw new Error(json.error);
      setLineRows(json.rows);
    } catch (e: any) {
      setMsg(e?.message ?? "load failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (tab !== "lines") return;
    loadLines();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, fTopic, fLens, fStance, fActive, fRole]);

  function startNewLine() {
    setIsNewLine(true);
    setEditingLine({
      id: "",
      topic: fTopic || "交際費",
      stance: (fStance as Stance) || "attack",
      lens: (fLens as Lens) || "substance",
      role: (fRole as Role) || "user",
      text: "",
      priority: 100,
      is_active: true,
    });
  }

  function startEditLine(r: LineRow) {
    setIsNewLine(false);
    setEditingLine({ ...r });
  }

  async function saveLine() {
    if (!editingLine) return;
    setLoading(true);
    setMsg(null);
    try {
      if (!editingLine.topic.trim()) throw new Error("topic is required");
      if (!editingLine.text.trim()) throw new Error("text is required");

      const payload = {
        topic: editingLine.topic,
        stance: editingLine.stance,
        lens: editingLine.lens,
        role: editingLine.role,
        text: editingLine.text,
        priority: editingLine.priority,
        is_active: editingLine.is_active,
      };

      if (isNewLine) {
        const res = await apiFetch(`/api/admin/knowledge-lines`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        const json = (await res.json()) as ApiRowLinesRes;
        if (!json.ok) throw new Error(json.error);
      } else {
        const res = await apiFetch(`/api/admin/knowledge-lines/${editingLine.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        const json = (await res.json()) as any;
        if (!json.ok) throw new Error(json.error);
      }

      setEditingLine(null);
      setIsNewLine(false);
      await loadLines();
    } catch (e: any) {
      setMsg(e?.message ?? "save failed");
    } finally {
      setLoading(false);
    }
  }

  async function removeLine(id: string) {
    if (!confirm("削除する？（戻せない）")) return;
    setLoading(true);
    setMsg(null);
    try {
      const res = await apiFetch(`/api/admin/knowledge-lines/${id}`, { method: "DELETE" });
      const json = (await res.json()) as any;
      if (!json.ok) throw new Error(json.error || "delete failed");
      setEditingLine(null);
      await loadLines();
    } catch (e: any) {
      setMsg(e?.message ?? "delete failed");
    } finally {
      setLoading(false);
    }
  }

  // =========================
  // QA tab state
  // =========================
  const [qaRows, setQaRows] = useState<QaRow[]>([]);
  const [qTopic, setQTopic] = useState("");
  const [qActive, setQActive] = useState(""); // "", "true", "false"
  const [qQuery, setQQuery] = useState(""); // keyword title/content

  const [qaEditing, setQaEditing] = useState<QaRow | null>(null);
  const [isNewQa, setIsNewQa] = useState(false);

  const qaTopics = useMemo(() => uniq(qaRows.map((r) => r.topic)), [qaRows]);

  async function loadQa() {
    setLoading(true);
    setMsg(null);
    try {
      const qs = new URLSearchParams();
      qs.set("kind", "qa");
      if (qTopic) qs.set("topic", qTopic);
      if (qActive) qs.set("active", qActive);
      if (qQuery.trim()) qs.set("q", qQuery.trim());

      const res = await apiFetch(`/api/admin/knowledge-items?${qs.toString()}`);
      const json = (await res.json()) as ApiListQaRes;
      if (!json.ok) throw new Error(json.error);
      setQaRows(json.rows);
    } catch (e: any) {
      setMsg(e?.message ?? "load failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (tab !== "qa") return;
    loadQa();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, qTopic, qActive, qQuery]);

  function startNewQa() {
    setIsNewQa(true);
    setQaEditing({
      id: "",
      kind: "qa",
      topic: qTopic || "交際費",
      title: "",
      content: "",
      priority: 50,
      is_active: true,
    });
  }

  function startEditQa(r: QaRow) {
    setIsNewQa(false);
    setQaEditing({ ...r });
  }

  function warnQaContent(all: string) {
    const hasNumberish = /(\d{1,3}(,\d{3})*|\d+)\s*(円|万円|%|％)/.test(all);
    const hasDecisionish = /(結論|つまり|なので|経費になる|損金|OK|アウト)/.test(all);
    if (hasNumberish || hasDecisionish) {
      return "QAは「結論・数字」を書かないルール。数字っぽい表現 or 断定語が混ざってるかも。最終判断はlinesへ。";
    }
    return null;
  }

  async function saveQa() {
    if (!qaEditing) return;
    setLoading(true);
    setMsg(null);
    try {
      if (!qaEditing.topic.trim()) throw new Error("topic is required");
      if (!qaEditing.title.trim()) throw new Error("title is required");
      if (!qaEditing.content.trim()) throw new Error("content is required");

      const w = warnQaContent(`${qaEditing.title}\n${qaEditing.content}`);
      if (w && !confirm(`${w}\n\nそれでも保存する？`)) {
        setLoading(false);
        return;
      }

      const payload = {
        kind: "qa",
        topic: qaEditing.topic,
        title: qaEditing.title,
        content: qaEditing.content,
        priority: qaEditing.priority,
        is_active: qaEditing.is_active,
      };

      if (isNewQa) {
        const res = await apiFetch(`/api/admin/knowledge-items`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        const json = (await res.json()) as ApiRowQaRes;
        if (!json.ok) throw new Error(json.error);
      } else {
        const res = await apiFetch(`/api/admin/knowledge-items/${qaEditing.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        const json = (await res.json()) as ApiRowQaRes;
        if (!json.ok) throw new Error(json.error);
      }

      setQaEditing(null);
      setIsNewQa(false);
      await loadQa();
    } catch (e: any) {
      setMsg(e?.message ?? "save failed");
    } finally {
      setLoading(false);
    }
  }

  async function removeQa(id: string) {
    if (!confirm("削除する？（戻せない）")) return;
    setLoading(true);
    setMsg(null);
    try {
      const res = await apiFetch(`/api/admin/knowledge-items/${id}`, { method: "DELETE" });
      const json = (await res.json()) as any;
      if (!json.ok) throw new Error(json.error || "delete failed");
      setQaEditing(null);
      await loadQa();
    } catch (e: any) {
      setMsg(e?.message ?? "delete failed");
    } finally {
      setLoading(false);
    }
  }

  // =========================
  // Debug tab state
  // =========================
  const [debugRows, setDebugRows] = useState<DebugRow[]>([]);
  const [dTopic, setDTopic] = useState("");
  const [dLens, setDLens] = useState("");
  const [dPath, setDPath] = useState("");
  const [dUsedKnowledge, setDUsedKnowledge] = useState(""); // "", "true", "false"
  const [dUsedLinesPick, setDUsedLinesPick] = useState(""); // "", "true", "false"
  const [dQuery, setDQuery] = useState("");
  const [dLimit, setDLimit] = useState(50);
  const [debugOpen, setDebugOpen] = useState<DebugRow | null>(null);

  const debugTopics = useMemo(() => uniq(debugRows.map((r) => r.inferred_topic)), [debugRows]);
  const allTopicsForDebug = useMemo(() => uniq([...lineTopics, ...qaTopics, ...debugTopics]), [lineTopics, qaTopics, debugTopics]);

  async function loadDebug() {
    setLoading(true);
    setMsg(null);
    try {
      const qs = new URLSearchParams();
      qs.set("limit", String(Math.max(1, Math.min(200, dLimit || 50))));
      if (dTopic) qs.set("topic", dTopic);
      if (dLens) qs.set("lens", dLens);
      if (dPath) qs.set("path", dPath);
      if (dUsedKnowledge) qs.set("used_knowledge", dUsedKnowledge);
      if (dUsedLinesPick) qs.set("used_lines_pick", dUsedLinesPick);
      if (dQuery.trim()) qs.set("q", dQuery.trim());

      const res = await apiFetch(`/api/admin/chat-debug?${qs.toString()}`);
      const json = (await res.json()) as ApiListDebugRes;
      if (!json.ok) throw new Error(json.error);
      setDebugRows(json.rows);
    } catch (e: any) {
      setMsg(e?.message ?? "load failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (tab !== "debug") return;
    loadDebug();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, dTopic, dLens, dPath, dUsedKnowledge, dUsedLinesPick, dQuery, dLimit]);

  // =========================
  // render
  // =========================
  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>Knowledge Admin</h1>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <TabButton active={tab === "lines"} onClick={() => setTab("lines")}>
            Lines
          </TabButton>
          <TabButton active={tab === "qa"} onClick={() => setTab("qa")}>
            QA
          </TabButton>
          <TabButton active={tab === "debug"} onClick={() => setTab("debug")}>
            Debug Logs
          </TabButton>
        </div>
      </div>

      {msg && <div style={{ marginBottom: 10, color: "crimson" }}>{msg}</div>}
      {loading && <div style={{ marginBottom: 10 }}>loading...</div>}

      {/* ===== Lines tab ===== */}
      {tab === "lines" && (
        <>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
            <label>
              topic&nbsp;
              <select value={fTopic} onChange={(e) => setFTopic(e.target.value)}>
                <option value="">(all)</option>
                {lineTopics.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>

            <label>
              lens&nbsp;
              <select value={fLens} onChange={(e) => setFLens(e.target.value)}>
                <option value="">(all)</option>
                <option value="amount">amount</option>
                <option value="substance">substance</option>
                <option value="system">system</option>
              </select>
            </label>

            <label>
              stance&nbsp;
              <select value={fStance} onChange={(e) => setFStance(e.target.value)}>
                <option value="">(all)</option>
                <option value="attack">attack</option>
                <option value="defense">defense</option>
              </select>
            </label>

            <label>
              role&nbsp;
              <select value={fRole} onChange={(e) => setFRole(e.target.value)}>
                <option value="">(all)</option>
                <option value="user">user</option>
                <option value="internal">internal</option>
              </select>
            </label>

            <label>
              active&nbsp;
              <select value={fActive} onChange={(e) => setFActive(e.target.value)}>
                <option value="">(all)</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            </label>

            <button onClick={startNewLine} disabled={loading} style={{ padding: "6px 10px" }}>
              ＋ 新規
            </button>

            <button onClick={loadLines} disabled={loading} style={{ padding: "6px 10px" }}>
              再読込
            </button>

            <button
              onClick={() => {
                const qs = new URLSearchParams();
                if (fTopic) qs.set("topic", fTopic);
                if (fLens) qs.set("lens", fLens);
                if (fStance) qs.set("stance", fStance);
                if (fActive) qs.set("active", fActive);
                if (fRole) qs.set("role", fRole);
                downloadCsv("/api/admin/knowledge-lines", qs, "knowledge_lines");
              }}
              disabled={loading}
              style={{ padding: "6px 10px" }}
            >
              CSV
            </button>
          </div>

          <TableScroller>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "#f6f6f6" }}>
                  <th style={{ textAlign: "left", padding: 8 }}>topic</th>
                  <th style={{ textAlign: "left", padding: 8 }}>lens</th>
                  <th style={{ textAlign: "left", padding: 8 }}>stance</th>
                  <th style={{ textAlign: "left", padding: 8 }}>role</th>
                  <th style={{ textAlign: "left", padding: 8 }}>priority</th>
                  <th style={{ textAlign: "left", padding: 8 }}>active</th>
                  <th style={{ textAlign: "left", padding: 8 }}>text</th>
                  <th style={{ padding: 8 }} />
                </tr>
              </thead>
              <tbody>
                {lineRows.map((r) => (
                  <tr key={r.id} style={{ borderTop: "1px solid #eee" }}>
                    <td style={{ padding: 8, whiteSpace: "nowrap" }}>{r.topic}</td>
                    <td style={{ padding: 8, whiteSpace: "nowrap" }}>{r.lens}</td>
                    <td style={{ padding: 8, whiteSpace: "nowrap" }}>{r.stance}</td>
                    <td style={{ padding: 8, whiteSpace: "nowrap" }}>
                      <Chip label={r.role} tone={r.role === "user" ? "ok" : "ng"} />
                    </td>
                    <td style={{ padding: 8, whiteSpace: "nowrap" }}>{r.priority}</td>
                    <td style={{ padding: 8, whiteSpace: "nowrap" }}>{String(r.is_active)}</td>
                    <td style={{ padding: 8 }}>{r.text}</td>
                    <td style={{ padding: 8, whiteSpace: "nowrap" }}>
                      <button onClick={() => startEditLine(r)} style={{ padding: "4px 8px" }}>
                        編集
                      </button>
                    </td>
                  </tr>
                ))}
                {lineRows.length === 0 && (
                  <tr>
                    <td colSpan={8} style={{ padding: 12, color: "#666" }}>
                      No rows
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </TableScroller>

          {editingLine && (
            <div
              style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.35)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 16,
                zIndex: 9999,
              }}
              onClick={() => setEditingLine(null)}
            >
              <div
                style={{
                  width: "min(900px, 100%)",
                  maxHeight: "min(86vh, 900px)",
                  overflowY: "auto",
                  background: "white",
                  borderRadius: 12,
                  padding: 14,
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <div style={{ fontWeight: 700 }}>{isNewLine ? "新規作成" : "編集"}</div>
                  <button onClick={() => setEditingLine(null)}>×</button>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                  <label>
                    topic
                    <input
                      value={editingLine.topic}
                      onChange={(e) => setEditingLine({ ...editingLine, topic: e.target.value })}
                      style={{ width: "100%" }}
                    />
                  </label>

                  <label>
                    priority
                    <input
                      type="number"
                      value={editingLine.priority}
                      onChange={(e) => setEditingLine({ ...editingLine, priority: Number(e.target.value) })}
                      style={{ width: "100%" }}
                    />
                  </label>

                  <label>
                    lens
                    <select
                      value={editingLine.lens}
                      onChange={(e) => setEditingLine({ ...editingLine, lens: e.target.value as Lens })}
                      style={{ width: "100%" }}
                    >
                      <option value="amount">amount</option>
                      <option value="substance">substance</option>
                      <option value="system">system</option>
                    </select>
                  </label>

                  <label>
                    stance
                    <select
                      value={editingLine.stance}
                      onChange={(e) => setEditingLine({ ...editingLine, stance: e.target.value as Stance })}
                      style={{ width: "100%" }}
                    >
                      <option value="attack">attack</option>
                      <option value="defense">defense</option>
                    </select>
                  </label>

                  <label>
                    role
                    <select
                      value={editingLine.role}
                      onChange={(e) => setEditingLine({ ...editingLine, role: e.target.value as Role })}
                      style={{ width: "100%" }}
                    >
                      <option value="user">user（ユーザーに出る）</option>
                      <option value="internal">internal（管理用・絶対出さない）</option>
                    </select>
                  </label>
                </div>

                <label style={{ display: "block", marginBottom: 10 }}>
                  text
                  <textarea
                    value={editingLine.text}
                    onChange={(e) => setEditingLine({ ...editingLine, text: e.target.value })}
                    rows={8}
                    style={{ width: "100%" }}
                  />
                </label>

                <label style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <input
                    type="checkbox"
                    checked={editingLine.is_active}
                    onChange={(e) => setEditingLine({ ...editingLine, is_active: e.target.checked })}
                  />
                  is_active
                </label>

                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                  {!isNewLine && (
                    <button onClick={() => removeLine(editingLine.id)} disabled={loading} style={{ padding: "6px 10px" }}>
                      削除
                    </button>
                  )}
                  <button onClick={saveLine} disabled={loading} style={{ padding: "6px 10px" }}>
                    保存
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* ===== QA tab ===== */}
      {tab === "qa" && (
        <>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
            <label>
              topic&nbsp;
              <select value={qTopic} onChange={(e) => setQTopic(e.target.value)}>
                <option value="">(all)</option>
                {qaTopics.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>

            <label>
              active&nbsp;
              <select value={qActive} onChange={(e) => setQActive(e.target.value)}>
                <option value="">(all)</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            </label>

            <label>
              search&nbsp;
              <input value={qQuery} onChange={(e) => setQQuery(e.target.value)} placeholder="title / content" />
            </label>

            <button onClick={startNewQa} disabled={loading} style={{ padding: "6px 10px" }}>
              ＋ 新規
            </button>

            <button onClick={loadQa} disabled={loading} style={{ padding: "6px 10px" }}>
              再読込
            </button>

            <button
              onClick={() => {
                const qs = new URLSearchParams();
                qs.set("kind", "qa");
                if (qTopic) qs.set("topic", qTopic);
                if (qActive) qs.set("active", qActive);
                if (qQuery.trim()) qs.set("q", qQuery.trim());
                downloadCsv("/api/admin/knowledge-items", qs, "knowledge_items_qa");
              }}
              disabled={loading}
              style={{ padding: "6px 10px" }}
            >
              CSV
            </button>
          </div>

          <TableScroller>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "#f6f6f6" }}>
                  <th style={{ textAlign: "left", padding: 8 }}>topic</th>
                  <th style={{ textAlign: "left", padding: 8 }}>priority</th>
                  <th style={{ textAlign: "left", padding: 8 }}>active</th>
                  <th style={{ textAlign: "left", padding: 8 }}>title</th>
                  <th style={{ textAlign: "left", padding: 8 }}>content</th>
                  <th style={{ padding: 8 }} />
                </tr>
              </thead>
              <tbody>
                {qaRows.map((r) => (
                  <tr key={r.id} style={{ borderTop: "1px solid #eee" }}>
                    <td style={{ padding: 8, whiteSpace: "nowrap" }}>{r.topic}</td>
                    <td style={{ padding: 8, whiteSpace: "nowrap" }}>{r.priority}</td>
                    <td style={{ padding: 8, whiteSpace: "nowrap" }}>{String(r.is_active)}</td>
                    <td style={{ padding: 8, fontWeight: 700 }}>{r.title}</td>
                    <td style={{ padding: 8 }}>
                      <div style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                        {r.content}
                      </div>
                    </td>
                    <td style={{ padding: 8, whiteSpace: "nowrap" }}>
                      <button onClick={() => startEditQa(r)} style={{ padding: "4px 8px" }}>
                        編集
                      </button>
                    </td>
                  </tr>
                ))}
                {qaRows.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ padding: 12, color: "#666" }}>
                      No rows
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </TableScroller>

          {qaEditing && (
            <div
              style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.35)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 16,
                zIndex: 9999,
              }}
              onClick={() => setQaEditing(null)}
            >
              <div
                style={{
                  width: "min(980px, 100%)",
                  height: "min(92vh, 900px)",
                  background: "white",
                  borderRadius: 12,
                  padding: 14,
                  display: "flex",
                  flexDirection: "column",
                  overflow: "hidden",
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <div style={{ fontWeight: 700 }}>{isNewQa ? "QA 新規作成" : "QA 編集"}</div>
                  <button onClick={() => setQaEditing(null)}>×</button>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "2fr 2fr 1fr", gap: 10, marginBottom: 10 }}>
                  <label>
                    topic
                    <input
                      value={qaEditing.topic}
                      onChange={(e) => setQaEditing({ ...qaEditing, topic: e.target.value })}
                      style={{ width: "100%", fontSize: 16, padding: "8px 10px" }}
                    />
                  </label>

                  <label>
                    title
                    <textarea
                      value={qaEditing.title}
                      onChange={(e) => setQaEditing({ ...qaEditing, title: e.target.value })}
                      rows={2}
                      style={{ width: "100%", fontSize: 16, lineHeight: 1.4, padding: "8px 10px", resize: "vertical" }}
                    />
                  </label>

                  <label>
                    priority
                    <input
                      type="number"
                      value={qaEditing.priority}
                      onChange={(e) => setQaEditing({ ...qaEditing, priority: Number(e.target.value) })}
                      style={{ width: "100%", fontSize: 16, padding: "8px 10px" }}
                    />
                  </label>
                </div>

                <div style={{ flex: 1, overflowY: "auto" }}>
                  <label style={{ display: "block", marginBottom: 10 }}>
                    content
                    <textarea
                      value={qaEditing.content}
                      onChange={(e) => setQaEditing({ ...qaEditing, content: e.target.value })}
                      rows={14}
                      style={{ width: "100%", fontSize: 16, lineHeight: 1.6 }}
                    />
                  </label>
                </div>

                <div style={{ borderTop: "1px solid #eee", paddingTop: 10 }}>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                    <input
                      type="checkbox"
                      checked={qaEditing.is_active}
                      onChange={(e) => setQaEditing({ ...qaEditing, is_active: e.target.checked })}
                    />
                    is_active
                  </label>

                  <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                    {!isNewQa && (
                      <button onClick={() => removeQa(qaEditing.id)} disabled={loading} style={{ padding: "10px 12px" }}>
                        削除
                      </button>
                    )}
                    <button onClick={saveQa} disabled={loading} style={{ padding: "10px 12px" }}>
                      保存
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* ===== Debug tab ===== */}
      {tab === "debug" && (
        <>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12, alignItems: "flex-end" }}>
            <label>
              topic&nbsp;
              <select value={dTopic} onChange={(e) => setDTopic(e.target.value)}>
                <option value="">(all)</option>
                {allTopicsForDebug.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>

            <label>
              lens&nbsp;
              <select value={dLens} onChange={(e) => setDLens(e.target.value)}>
                <option value="">(all)</option>
                <option value="amount">amount</option>
                <option value="substance">substance</option>
                <option value="system">system</option>
              </select>
            </label>

            <label>
              path&nbsp;
              <select value={dPath} onChange={(e) => setDPath(e.target.value)}>
                <option value="">(all)</option>
                <option value="normal_llm">normal_llm</option>
                <option value="followup_lines">followup_lines</option>
                <option value="followup_kb">followup_kb</option>
                <option value="followup_fallback">followup_fallback</option>
              </select>
            </label>

            <label>
              used_knowledge&nbsp;
              <select value={dUsedKnowledge} onChange={(e) => setDUsedKnowledge(e.target.value)}>
                <option value="">(all)</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            </label>

            <label>
              used_lines_pick&nbsp;
              <select value={dUsedLinesPick} onChange={(e) => setDUsedLinesPick(e.target.value)}>
                <option value="">(all)</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            </label>

            <label>
              search&nbsp;
              <input value={dQuery} onChange={(e) => setDQuery(e.target.value)} placeholder="message_head" />
            </label>

            <label>
              limit&nbsp;
              <input type="number" value={dLimit} onChange={(e) => setDLimit(Number(e.target.value))} style={{ width: 90 }} />
            </label>

            <button onClick={loadDebug} disabled={loading} style={{ padding: "6px 10px" }}>
              再読込
            </button>

            <button
              onClick={() => {
                const qs = new URLSearchParams();
                qs.set("limit", String(Math.max(1, Math.min(200, dLimit || 50))));
                if (dTopic) qs.set("topic", dTopic);
                if (dLens) qs.set("lens", dLens);
                if (dPath) qs.set("path", dPath);
                if (dUsedKnowledge) qs.set("used_knowledge", dUsedKnowledge);
                if (dUsedLinesPick) qs.set("used_lines_pick", dUsedLinesPick);
                if (dQuery.trim()) qs.set("q", dQuery.trim());
                downloadCsv("/api/admin/chat-debug", qs, "chat_debug_events");
              }}
              disabled={loading}
              style={{ padding: "6px 10px" }}
            >
              CSV
            </button>
          </div>

          <TableScroller>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "#f6f6f6" }}>
                  <th style={{ textAlign: "left", padding: 8 }}>created</th>
                  <th style={{ textAlign: "left", padding: 8 }}>topic</th>
                  <th style={{ textAlign: "left", padding: 8 }}>topics_now</th>
                  <th style={{ textAlign: "left", padding: 8 }}>lens</th>
                  <th style={{ textAlign: "left", padding: 8 }}>path</th>
                  <th style={{ textAlign: "left", padding: 8 }}>K</th>
                  <th style={{ textAlign: "left", padding: 8 }}>L</th>
                  <th style={{ textAlign: "left", padding: 8 }}>picked_qa</th>
                  <th style={{ textAlign: "left", padding: 8 }}>picked_lines</th>
                  <th style={{ textAlign: "left", padding: 8 }}>message</th>
                  <th style={{ padding: 8 }} />
                </tr>
              </thead>
              <tbody>
                {debugRows.map((r) => {
                  const pq = (r.meta?.picked_qa ?? []) as PickedQaMeta[];
                  const pl = (r.meta?.picked_lines ?? []) as PickedLineMeta[];

                  return (
                    <tr key={r.id} style={{ borderTop: "1px solid #eee" }}>
                      <td style={{ padding: 8, whiteSpace: "nowrap", color: "#555" }}>{(r.created_at ?? "").replace("T", " ").slice(0, 19)}</td>
                      <td style={{ padding: 8, whiteSpace: "nowrap" }}>{r.inferred_topic}</td>

                      <td style={{ padding: 8, minWidth: 260 }}>
                        {Array.isArray(r.topics_now) && r.topics_now.length > 0 ? (
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            {r.topics_now.slice(0, 6).map((t) => (
                              <Chip key={t} label={t} />
                            ))}
                            {r.topics_now.length > 6 && <Chip label={`+${r.topics_now.length - 6}`} tone="muted" />}
                          </div>
                        ) : (
                          <span style={{ color: "#888" }}>-</span>
                        )}
                      </td>

                      <td style={{ padding: 8, whiteSpace: "nowrap" }}>{r.lens}</td>
                      <td style={{ padding: 8, whiteSpace: "nowrap" }}>
                        <Chip label={r.path} />
                      </td>
                      <td style={{ padding: 8, whiteSpace: "nowrap" }}>
                        <Chip label={String(r.used_knowledge)} tone={r.used_knowledge ? "ok" : "muted"} />
                      </td>
                      <td style={{ padding: 8, whiteSpace: "nowrap" }}>
                        <Chip label={String(r.used_lines_pick)} tone={r.used_lines_pick ? "ok" : "muted"} />
                      </td>
                      <td style={{ padding: 8 }}>
                        {pq.length === 0 ? (
                          <span style={{ color: "#888" }}>-</span>
                        ) : (
                          <div style={{ display: "grid", gap: 2 }}>
                            {pq.slice(0, 3).map((q) => (
                              <div key={q.id} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 320 }}>
                                <Chip label={`p${q.priority}`} />&nbsp;<span style={{ fontWeight: 700 }}>{q.title}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: 8 }}>
                        {pl.length === 0 ? (
                          <span style={{ color: "#888" }}>-</span>
                        ) : (
                          <div style={{ display: "grid", gap: 2 }}>
                            {pl.slice(0, 2).map((ln) => (
                              <div key={ln.id} style={{ whiteSpace: "nowrap" }}>
                                <Chip label={ln.stance} /> <Chip label={ln.lens} /> <Chip label={`p${ln.priority}`} />{" "}
                                <span style={{ color: "#666" }}>{ln.topic}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: 8, maxWidth: 420 }}>
                        <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.message_head}</div>
                      </td>
                      <td style={{ padding: 8, whiteSpace: "nowrap" }}>
                        <button onClick={() => setDebugOpen(r)} style={{ padding: "4px 8px" }}>
                          詳細
                        </button>
                      </td>
                    </tr>
                  );
                })}

                {debugRows.length === 0 && (
                  <tr>
                    <td colSpan={11} style={{ padding: 12, color: "#666" }}>
                      No rows
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </TableScroller>

          {debugOpen && (
            <div
              style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.35)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 16,
                zIndex: 9999,
              }}
              onClick={() => setDebugOpen(null)}
            >
              <div
                style={{
                  width: "min(980px, 100%)",
                  maxHeight: "min(92vh, 900px)",
                  overflowY: "auto",
                  background: "white",
                  borderRadius: 12,
                  padding: 14,
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <div style={{ fontWeight: 700 }}>Debug Event</div>
                  <button onClick={() => setDebugOpen(null)}>×</button>
                </div>

                <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
                  <div>
                    <Chip label={(debugOpen.created_at ?? "").replace("T", " ").slice(0, 19)} />{" "}
                    <Chip label={`topic: ${debugOpen.inferred_topic || "-"}`} /> <Chip label={`lens: ${debugOpen.lens}`} />{" "}
                    <Chip label={`path: ${debugOpen.path}`} />
                  </div>

                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Chip label={`used_knowledge: ${String(debugOpen.used_knowledge)}`} tone={debugOpen.used_knowledge ? "ok" : "muted"} />
                    <Chip label={`used_lines_pick: ${String(debugOpen.used_lines_pick)}`} tone={debugOpen.used_lines_pick ? "ok" : "muted"} />
                    <Chip label={`followup: ${String(debugOpen.followup)}`} />
                    <Chip label={`shifted: ${String(debugOpen.shifted)}`} />
                    <Chip label={`borrowed_prev_topic: ${String(Boolean(debugOpen.meta?.borrowed_prev_topic))}`} />
                  </div>

                  <div style={{ padding: 10, border: "1px solid #eee", borderRadius: 10 }}>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>topics_now</div>
                    <div style={{ whiteSpace: "pre-wrap" }}>{(debugOpen.topics_now ?? []).join(", ") || "-"}</div>
                  </div>

                  <div style={{ padding: 10, border: "1px solid #eee", borderRadius: 10 }}>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>message_head</div>
                    <div style={{ whiteSpace: "pre-wrap" }}>{debugOpen.message_head}</div>
                  </div>

                  <div style={{ padding: 10, border: "1px solid #eee", borderRadius: 10 }}>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>meta</div>
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(debugOpen.meta ?? {}, null, 2)}</pre>
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
