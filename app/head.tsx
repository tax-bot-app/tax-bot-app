export default function Head() {
  return (
    <>
      <title>さじかげん｜税務相談</title>
      <meta name="description" content="あなたの欲しい ちょうどいい さじかげん" />

      <link rel="manifest" href="/manifest.webmanifest" />

      <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png" />
      <link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png" />
      <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />

      {/* iOS で “ホーム画面アプリっぽく” */}
      <meta name="apple-mobile-web-app-capable" content="yes" />
      <meta name="apple-mobile-web-app-title" content="さじかげん" />
    </>
  );
}
