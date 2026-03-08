"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

type FeedbackKind = "report_answer" | "contact" | "request";

type DraftPayload = {
  conversation_id?: string | null;
  message_id?: string | null;
  target_answer?: string | null;
  context_messages?: Array<{
    id?: string;
    role?: "user" | "assistant";
    content?: string;
    created_at?: string;
  }>;
  page_path?: string | null;
} | null;

const DRAFT_KEY = "feedback:draft:v1";

function normalizeKind(raw: string | null): FeedbackKind {
  if (raw === "report_answer") return "report_answer";
  if (raw === "request") return "request";
  return "contact";
}

function titleFor(kind: FeedbackKind) {
  if (kind === "report_answer") return "不適切な回答を報告";
  if (kind === "request") return "要望を送る";
  return "お問い合わせ";
}

function descriptionFor(kind: FeedbackKind) {
  if (kind === "report_answer") {
    return "気になる回答について、内容をお送りください。品質改善のため、該当する会話とあわせて確認する場合があります。";
  }
  if (kind === "request") {
    return "機能追加や改善要望などをお送りください。";
  }
  return "サービスに関するご意見・不具合・お問い合わせ内容をお送りください。";
}

export default function FeedbackNewPage() {
  const searchParams = useSearchParams();
  const kind = useMemo(() => normalizeKind(searchParams.get("kind")), [searchParams]);

  const [body, setBody] = useState("");
  const [draft, setDraft] = useState<DraftPayload>(null);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      if (!raw) {
        setDraft(null);
        return;
      }
      const parsed = JSON.parse(raw) as DraftPayload;
      setDraft(parsed);
    } catch {
      setDraft(null);
    }
  }, []);

  const minOk = body.trim().length >= 30;

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "24px 16px 80px" }}>
      <div style={{ marginBottom: 16 }}>
        <Link href="/chat" style={{ color: "#555", textDecoration: "none" }}>
          ← チャットに戻る
        </Link>
      </div>

      <h1 style={{ fontSize: 28, fontWeight: 900, marginBottom: 12 }}>
        {titleFor(kind)}
      </h1>

      <div
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 14,
          padding: 14,
          background: "#fafafa",
          color: "#333",
          lineHeight: 1.8,
          fontSize: 14,
          marginBottom: 18,
        }}
      >
        <p style={{ margin: 0 }}>{descriptionFor(kind)}</p>
        <p style={{ margin: "8px 0 0" }}>
          個人情報やカード番号等は入力しないでください。
        </p>
      </div>

      {kind === "report_answer" && draft?.target_answer && (
        <section
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 14,
            padding: 14,
            marginBottom: 18,
          }}
        >
          <div style={{ fontWeight: 900, marginBottom: 8 }}>対象の回答</div>
          <div
            style={{
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              lineHeight: 1.7,
              color: "#111",
              fontSize: 14,
            }}
          >
            {draft.target_answer}
          </div>

          {draft.conversation_id && (
            <div style={{ marginTop: 10, fontSize: 12, color: "#666" }}>
              conversation_id: {draft.conversation_id}
            </div>
          )}
        </section>
      )}

      <section>
        <label
          htmlFor="feedback-body"
          style={{ display: "block", fontWeight: 900, marginBottom: 8 }}
        >
          内容
        </label>

        <textarea
          id="feedback-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={
            kind === "report_answer"
              ? "どこが気になったかを入力してください"
              : kind === "request"
              ? "追加してほしいこと、改善してほしいことを入力してください"
              : "お問い合わせ内容を入力してください"
          }
          style={{
            width: "100%",
            minHeight: 220,
            border: "1px solid #d1d5db",
            borderRadius: 14,
            padding: 14,
            fontSize: 16,
            lineHeight: 1.8,
            resize: "vertical",
            boxSizing: "border-box",
          }}
        />

        <div style={{ marginTop: 8, fontSize: 13, color: minOk ? "#666" : "#b91c1c" }}>
          {body.trim().length}/30文字以上
        </div>
      </section>

      <div style={{ marginTop: 18, display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button
          type="button"
          disabled
          style={{
            padding: "12px 18px",
            borderRadius: 12,
            border: "1px solid #111",
            background: "#111",
            color: "#fff",
            fontWeight: 800,
            opacity: minOk ? 1 : 0.5,
            cursor: "not-allowed",
          }}
        >
          送信
        </button>

        <Link
          href="/feedback"
          style={{
            padding: "12px 18px",
            borderRadius: 12,
            border: "1px solid #d1d5db",
            color: "#111",
            textDecoration: "none",
          }}
        >
          送信履歴を見る
        </Link>
      </div>
    </main>
  );
}