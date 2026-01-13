export default function SuccessPage() {
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <div style={{ textAlign: "center" }}>
        <h1 style={{ fontSize: 32, fontWeight: 700 }}>申込完了</h1>
        <p style={{ marginTop: 12 }}>決済が完了しました。ありがとうございます。</p>
        <a href="/" style={{ display: "inline-block", marginTop: 20 }}>
          トップへ戻る
        </a>
      </div>
    </main>
  );
}
