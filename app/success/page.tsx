export default function SuccessPage() {
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <div style={{ textAlign: "center" }}>
        <h1 style={{ fontSize: 32, fontWeight: 700 }}>申込完了 🎉</h1>
        <p style={{ marginTop: 12 }}>
          決済が完了しました。ありがとうございます。<br />
          さっそく税務相談を始めましょう。
        </p>

        <a
          href="/chat"
          style={{
            display: "inline-block",
            marginTop: 24,
            padding: "14px 28px",
            backgroundColor: "#000",
            color: "#fff",
            borderRadius: 8,
            textDecoration: "none",
            fontWeight: 600,
          }}
        >
          いますぐ相談開始 →
        </a>
      </div>
    </main>
  );
}
