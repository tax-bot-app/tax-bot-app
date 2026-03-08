import Link from "next/link";

type FeedbackKind = "report_answer" | "contact" | "request";

function normalizeKind(raw?: string): FeedbackKind {
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

export default async function FeedbackNewPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  const params = await searchParams;
  const kind = normalizeKind(params?.kind);

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

      {kind === "report_answer" && (
        <section
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 14,
            padding: 14,
            marginBottom: 18,
            background: "#fafafa",
            color: "#666",
            fontSize: 14,
          }}
        >
          対象の回答は、送信処理の実装時に表示対応します。
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
            opacity: 0.5,
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