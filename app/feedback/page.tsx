"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { getSupabaseClient } from "@/app/lib/supabaseClient";
import type { FeedbackKind } from "@/app/lib/feedbackDraft";

type FeedbackRow = {
  id: string;
  kind: FeedbackKind;
  body: string;
  conversation_id: string | null;
  created_at: string;
};

function kindLabel(kind: FeedbackKind) {
  if (kind === "report_answer") return "不適切回答";
  if (kind === "request") return "要望";
  return "お問い合わせ";
}

function fmt(iso: string) {
  try {
    return new Date(iso).toLocaleString("ja-JP");
  } catch {
    return iso;
  }
}

export default function FeedbackPage() {
  const supabase = useMemo(() => getSupabaseClient(), []);
  const [rows, setRows] = useState<FeedbackRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    const run = async () => {
      setLoading(true);
      setErrMsg(null);

      try {
        const {
          data: { user },
          error: userErr,
        } = await supabase.auth.getUser();

        if (userErr || !user?.id) {
          throw new Error("ログイン状態を確認できませんでした。");
        }

        const { data, error } = await supabase
          .from("feedback_reports")
          .select("id, kind, body, conversation_id, created_at")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(100);

        if (error) throw error;
        if (!alive) return;

        setRows((data ?? []) as FeedbackRow[]);
      } catch (e: any) {
        if (!alive) return;
        setErrMsg(e?.message ?? "履歴の取得に失敗しました。");
      } finally {
        if (alive) setLoading(false);
      }
    };

    run();
    return () => {
      alive = false;
    };
  }, [supabase]);

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "24px 16px 80px" }}>
      <div style={{ marginBottom: 16 }}>
        <Link href="/chat" style={{ color: "#555", textDecoration: "none" }}>
          ← チャットに戻る
        </Link>
      </div>

      <h1 style={{ fontSize: 28, fontWeight: 900, marginBottom: 12 }}>
        送信履歴
      </h1>

      <div
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 14,
          padding: 16,
          background: "#fafafa",
          color: "#333",
          lineHeight: 1.8,
          fontSize: 14,
          marginBottom: 18,
        }}
      >
        ここでは、ご自身が送信したお問い合わせ・要望・回答報告の履歴を確認できます。
      </div>

      {errMsg && (
        <div
          style={{
            border: "1px solid #fecaca",
            background: "#fef2f2",
            color: "#991b1b",
            borderRadius: 14,
            padding: 14,
            lineHeight: 1.8,
            fontSize: 14,
            marginBottom: 18,
          }}
        >
          {errMsg}
        </div>
      )}

      {loading ? (
        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 14,
            padding: 20,
            textAlign: "center",
            color: "#666",
          }}
        >
          読み込み中…
        </div>
      ) : rows.length === 0 ? (
        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 14,
            padding: 20,
            textAlign: "center",
            color: "#666",
          }}
        >
          まだ送信履歴はありません。
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {rows.map((row) => (
            <section
              key={row.id}
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 14,
                padding: 16,
                background: "#fff",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 10,
                  flexWrap: "wrap",
                  marginBottom: 10,
                }}
              >
                <div style={{ fontWeight: 900 }}>{kindLabel(row.kind)}</div>
                <div style={{ fontSize: 12, color: "#666" }}>{fmt(row.created_at)}</div>
              </div>

              <div
                style={{
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  lineHeight: 1.8,
                  fontSize: 14,
                  color: "#111",
                }}
              >
                {row.body}
              </div>
              </section>
          ))}
        </div>
      )}

      <div style={{ marginTop: 18 }}>
        <Link
          href="/feedback/new"
          style={{
            display: "inline-block",
            padding: "12px 18px",
            borderRadius: 12,
            border: "1px solid #111",
            background: "#111",
            color: "#fff",
            fontWeight: 800,
            textDecoration: "none",
          }}
        >
          新しく送る
        </Link>
      </div>
    </main>
  );
}