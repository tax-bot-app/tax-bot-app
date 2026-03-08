"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { getSupabaseClient } from "@/app/lib/supabaseClient";
import {
  clearFeedbackDraft,
  loadFeedbackDraft,
  normalizeFeedbackKind,
  readFeedbackCooldownLeftMs,
  writeFeedbackCooldown,
  type FeedbackDraft,
  type FeedbackKind,
} from "@/app/lib/feedbackDraft";

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

function kindLabel(kind: FeedbackKind) {
  if (kind === "report_answer") return "不適切回答";
  if (kind === "request") return "要望";
  return "お問い合わせ";
}

type Props = {
  initialKind: FeedbackKind;
};

export default function FeedbackNewClient({ initialKind }: Props) {
  const supabase = useMemo(() => getSupabaseClient(), []);
  const [kind, setKind] = useState<FeedbackKind>(normalizeFeedbackKind(initialKind));
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState<FeedbackDraft | null>(null);
  const [cooldownLeftMs, setCooldownLeftMs] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    if (initialKind === "report_answer") {
      setKind("report_answer");
      setDraft(loadFeedbackDraft());
    } else {
      setDraft(null);
      clearFeedbackDraft();
      setKind(normalizeFeedbackKind(initialKind));
    }
  }, [initialKind]);

  useEffect(() => {
    const tick = () => setCooldownLeftMs(readFeedbackCooldownLeftMs());
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const bodyLen = body.trim().length;
  const minOk = bodyLen >= 30;
  const canSubmit = !done && !submitting && minOk && cooldownLeftMs <= 0;

  const cooldownSec = Math.ceil(cooldownLeftMs / 1000);

  const pagePath = typeof window !== "undefined" ? window.location.pathname : "/feedback/new";
  const userAgent = typeof window !== "undefined" ? window.navigator.userAgent : "";
  const viewport =
    typeof window !== "undefined"
      ? { width: window.innerWidth, height: window.innerHeight }
      : { width: 0, height: 0 };

  const onSubmit = async () => {
    if (!canSubmit) return;

    setErrMsg(null);
    setSubmitting(true);

    try {
      const {
        data: { user },
        error: userErr,
      } = await supabase.auth.getUser();

      if (userErr || !user?.id) {
        throw new Error("ログイン状態を確認できませんでした。ログインし直してお試しください。");
      }

      const meta = {
        userAgent,
        viewport,
        dialect: draft?.dialect ?? null,
        stance: draft?.stance ?? null,
        appVersion:
          draft?.appVersion ??
          process.env.NEXT_PUBLIC_APP_VERSION ??
          null,
        target_answer: kind === "report_answer" ? draft?.target_answer ?? null : null,
        context_messages:
          kind === "report_answer" ? draft?.context_messages ?? [] : [],
      };

      const payload = {
        user_id: user.id,
        kind,
        body: body.trim(),
        conversation_id: kind === "report_answer" ? draft?.conversation_id ?? null : null,
        message_id: kind === "report_answer" ? draft?.message_id ?? null : null,
        page_path: draft?.page_path ?? pagePath,
        meta,
      };

      const { error } = await supabase.from("feedback_reports").insert(payload);
      if (error) throw error;

      writeFeedbackCooldown();
      if (kind === "report_answer") clearFeedbackDraft();

      setDone(true);
      setBody("");
      setCooldownLeftMs(readFeedbackCooldownLeftMs());
    } catch (e: any) {
      setErrMsg(e?.message ?? "送信に失敗しました。時間をおいて再度お試しください。");
    } finally {
      setSubmitting(false);
    }
  };

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

      {kind !== "report_answer" && (
        <section
          style={{
            marginBottom: 18,
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            onClick={() => setKind("contact")}
            style={{
              padding: "10px 14px",
              borderRadius: 12,
              border: "1px solid #d1d5db",
              background: kind === "contact" ? "#111" : "#fff",
              color: kind === "contact" ? "#fff" : "#111",
              fontWeight: 800,
              cursor: "pointer",
            }}
          >
            お問い合わせ
          </button>

          <button
            type="button"
            onClick={() => setKind("request")}
            style={{
              padding: "10px 14px",
              borderRadius: 12,
              border: "1px solid #d1d5db",
              background: kind === "request" ? "#111" : "#fff",
              color: kind === "request" ? "#fff" : "#111",
              fontWeight: 800,
              cursor: "pointer",
            }}
          >
            要望
          </button>
        </section>
      )}

      {kind === "report_answer" && (
        <section
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 14,
            padding: 14,
            marginBottom: 18,
            background: "#fafafa",
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
            {draft?.target_answer?.trim() || "対象の回答が見つかりませんでした。"}
          </div>

          {!!draft?.conversation_id && (
            <div style={{ marginTop: 10, fontSize: 12, color: "#666" }}>
              conversation_id: {draft.conversation_id}
            </div>
          )}
        </section>
      )}

      {done && (
        <div
          style={{
            border: "1px solid #d1fae5",
            background: "#ecfdf5",
            color: "#065f46",
            borderRadius: 14,
            padding: 14,
            lineHeight: 1.8,
            fontSize: 14,
            marginBottom: 18,
          }}
        >
          送信を受け付けました。<br />
          いただいた内容は今後の品質改善に活かします。
        </div>
      )}

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
          disabled={done}
        />

        <div
          style={{
            marginTop: 8,
            fontSize: 13,
            color: bodyLen >= 30 ? "#666" : "#b91c1c",
          }}
        >
          {bodyLen}/30文字以上
        </div>

        {cooldownLeftMs > 0 && !done && (
          <div style={{ marginTop: 6, fontSize: 13, color: "#92400e" }}>
            連続送信防止のため、あと {cooldownSec} 秒お待ちください。
          </div>
        )}
      </section>

      <div style={{ marginTop: 18, display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit}
          style={{
            padding: "12px 18px",
            borderRadius: 12,
            border: "1px solid #111",
            background: "#111",
            color: "#fff",
            fontWeight: 800,
            opacity: canSubmit ? 1 : 0.5,
            cursor: canSubmit ? "pointer" : "not-allowed",
          }}
        >
          {submitting ? "送信中…" : "送信"}
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

      <div style={{ marginTop: 14, fontSize: 12, color: "#666" }}>
        種別: {kindLabel(kind)}
      </div>
    </main>
  );
}