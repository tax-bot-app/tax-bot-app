export const dynamic = "force-dynamic";

export default function MaintenancePage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: "24px",
      }}
    >
      <section
        style={{
          width: "min(560px, 100%)",
          border: "1px solid rgba(0,0,0,0.12)",
          borderRadius: "16px",
          padding: "20px",
          background: "rgba(255,255,255,0.7)",
          backdropFilter: "blur(8px)",
        }}
      >
        <h1 style={{ fontSize: "20px", margin: 0 }}>メンテナンス中です</h1>

        <p style={{ marginTop: "10px", marginBottom: "14px", lineHeight: 1.7 }}>
          ただいま一時的にご利用を制限しています。
          <br />
          しばらく時間をおいて、再度アクセスしてください。
        </p>

        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          <a
            href="/login"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "10px 12px",
              borderRadius: "12px",
              border: "1px solid rgba(0,0,0,0.18)",
              textDecoration: "none",
            }}
          >
            ログインへ
          </a>

          <a
            href="/"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "10px 12px",
              borderRadius: "12px",
              border: "1px solid rgba(0,0,0,0.18)",
              textDecoration: "none",
            }}
          >
            トップへ
          </a>
        </div>

        <p style={{ marginTop: "14px", opacity: 0.7, fontSize: "12px" }}>
          ※ログイン済みの方は、soft の場合は通常どおり利用できます。
        </p>
      </section>
    </main>
  );
}