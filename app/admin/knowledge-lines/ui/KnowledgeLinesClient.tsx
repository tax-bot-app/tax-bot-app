"use client";

import { useEffect, useMemo, useState } from "react";
import { getSupabaseClient } from "@/app/lib/supabaseClient";

type Role = "user" | "internal";
type Stance = "attack" | "defense";
type Lens = "amount" | "substance" | "system";

type Row = {
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

type ApiListRes = { ok: true; rows: Row[] } | { ok: false; error: string };
type ApiRowRes = { ok: true; row: Row } | { ok: false; error: string };

function uniq(xs: string[]) {
  return Array.from(new Set(xs)).sort((a, b) => a.localeCompare(b, "ja"));
}

export default function KnowledgeLinesClient() {
  const supabase = useMemo(() => getSupabaseClient(), []);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // filters
  const [fTopic, setFTopic] = useState("");
  const [fLens, setFLens] = useState("");
  const [fStance, setFStance] = useState("");
  const [fActive, setFActive] = useState(""); // "", "true", "false"
  const [fRole, setFRole] = useState(""); // "", "user", "internal"

  // editor
  const [editing, setEditing] = useState<Row | null>(null);
  const [isNew, setIsNew] = useState(false);

  const topics = useMemo(() => uniq(rows.map((r) => r.topic)), [rows]);

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

  async function load() {
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
      const json = (await res.json()) as ApiListRes;
      if (!json.ok) throw new Error(json.error);
      setRows(json.rows);
    } catch (e: any) {
      setMsg(e?.message ?? "load failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fTopic, fLens, fStance, fActive, fRole]);

  function startNew() {
    setIsNew(true);
    setEditing({
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

  function startEdit(r: Row) {
    setIsNew(false);
    setEditing({ ...r });
  }

  async function save() {
    if (!editing) return;
    setLoading(true);
    setMsg(null);
    try {
      if (!editing.topic.trim()) throw new Error("topic is required");
      if (!editing.text.trim()) throw new Error("text is required");

      const payload = {
        topic: editing.topic,
        stance: editing.stance,
        lens: editing.lens,
        role: editing.role,
        text: editing.text,
        priority: editing.priority,
        is_active: editing.is_active,
      };

      if (isNew) {
        const res = await apiFetch(`/api/admin/knowledge-lines`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        const json = (await res.json()) as ApiRowRes;
        if (!json.ok) throw new Error(json.error);
      } else {
        const res = await apiFetch(`/api/admin/knowledge-lines/${editing.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        const json = (await res.json()) as ApiRowRes;
        if (!json.ok) throw new Error(json.error);
      }

      setEditing(null);
      setIsNew(false);
      await load();
    } catch (e: any) {
      setMsg(e?.message ?? "save failed");
    } finally {
      setLoading(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("削除する？（戻せない）")) return;
    setLoading(true);
    setMsg(null);
    try {
      const res = await apiFetch(`/api/admin/knowledge-lines/${id}`, { method: "DELETE" });
      const json = (await res.json()) as any;
      if (!json.ok) throw new Error(json.error || "delete failed");
      setEditing(null);
      await load();
    } catch (e: any) {
      setMsg(e?.message ?? "delete failed");
    } finally {
      setLoading(false);
    }
  }

  const shown = rows;

  return (
    <div style={{ padding: 16 }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>Knowledge Lines</h1>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <label>
          topic&nbsp;
          <select value={fTopic} onChange={(e) => setFTopic(e.target.value)}>
            <option value="">(all)</option>
            {topics.map((t) => (
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

        <button onClick={startNew} disabled={loading} style={{ padding: "6px 10px" }}>
          ＋ 新規
        </button>

        <button onClick={load} disabled={loading} style={{ padding: "6px 10px" }}>
          再読込
        </button>
      </div>

      {msg && <div style={{ marginBottom: 10, color: "crimson" }}>{msg}</div>}
      {loading && <div style={{ marginBottom: 10 }}>loading...</div>}

      <div style={{ border: "1px solid #ddd", borderRadius: 8, overflow: "hidden" }}>
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
            {shown.map((r) => (
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
                  <button onClick={() => startEdit(r)} style={{ padding: "4px 8px" }}>
                    編集
                  </button>
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={8} style={{ padding: 12, color: "#666" }}>
                  No rows
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
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
          onClick={() => setEditing(null)}
        >
          <div
            style={{ width: "min(900px, 100%)", background: "white", borderRadius: 12, padding: 14 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={{ fontWeight: 700 }}>{isNew ? "新規作成" : "編集"}</div>
              <button onClick={() => setEditing(null)}>×</button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
              <label>
                topic
                <input
                  value={editing.topic}
                  onChange={(e) => setEditing({ ...editing, topic: e.target.value })}
                  style={{ width: "100%" }}
                />
              </label>

              <label>
                lens
                <select
                  value={editing.lens}
                  onChange={(e) => setEditing({ ...editing, lens: e.target.value as Lens })}
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
                  value={editing.stance}
                  onChange={(e) => setEditing({ ...editing, stance: e.target.value as Stance })}
                  style={{ width: "100%" }}
                >
                  <option value="attack">attack</option>
                  <option value="defense">defense</option>
                </select>
              </label>

              <label>
                role
                <select
                  value={editing.role}
                  onChange={(e) => setEditing({ ...editing, role: e.target.value as Role })}
                  style={{ width: "100%" }}
                >
                  <option value="user">user（ユーザーに出る）</option>
                  <option value="internal">internal（管理用・絶対出さない）</option>
                </select>
              </label>

              <label>
                priority
                <input
                  type="number"
                  value={editing.priority}
                  onChange={(e) => setEditing({ ...editing, priority: Number(e.target.value) })}
                  style={{ width: "100%" }}
                />
              </label>
            </div>

            <label style={{ display: "block", marginBottom: 10 }}>
              text
              <textarea
                value={editing.text}
                onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                rows={6}
                style={{ width: "100%" }}
              />
            </label>

            <label style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <input
                type="checkbox"
                checked={editing.is_active}
                onChange={(e) => setEditing({ ...editing, is_active: e.target.checked })}
              />
              is_active
            </label>

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              {!isNew && (
                <button onClick={() => remove(editing.id)} disabled={loading} style={{ padding: "6px 10px" }}>
                  削除
                </button>
              )}
              <button onClick={save} disabled={loading} style={{ padding: "6px 10px" }}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
