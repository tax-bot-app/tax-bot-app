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

function uniq(xs: string[]) {
  return Array.from(new Set(xs)).sort((a, b) => a.localeCompare(b, "ja"));
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
    <div
      style={{
        border: "1px solid #ddd",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          overflowX: "auto",
          overflowY: "hidden",
          WebkitOverflowScrolling: "touch",
          maxWidth: "100%",
        }}
      >
        {/* テーブルが縮まないように minWidth を確保 */}
        <div style={{ minWidth: 980 }}>{props.children}</div>
      </div>
    </div>
  );
}

export default function KnowledgeLinesClient() {
  const supabase = useMemo(() => getSupabaseClient(), []);
  const [tab, setTab] = useState<"lines" | "qa">("lines");

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
  // render
  // =========================
  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>Knowledge Admin</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <TabButton active={tab === "lines"} onClick={() => setTab("lines")}>
            Lines
          </TabButton>
          <TabButton active={tab === "qa"} onClick={() => setTab("qa")}>
            QA
          </TabButton>
        </div>
      </div>

      {msg && <div style={{ marginBottom: 10, color: "crimson" }}>{msg}</div>}
      {loading && <div style={{ marginBottom: 10 }}>loading...</div>}

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
                      <span
                        style={{
                          padding: "2px 8px",
                          borderRadius: 999,
                          border: "1px solid #ddd",
                          background: r.role === "user" ? "#f6fff6" : "#fff6f6",
                        }}
                      >
                        {r.role}
                      </span>
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
                <div
                  style={{
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }}
                >
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
              <input
                value={qaEditing.title}
                onChange={(e) => setQaEditing({ ...qaEditing, title: e.target.value })}
                style={{ width: "100%", fontSize: 16, padding: "8px 10px" }}
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

    </div>
  );
}
