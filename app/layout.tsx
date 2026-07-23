import { Suspense } from "react";
import Script from "next/script";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource/yuji-syuku/japanese-400.css";
import "./globals.css";
import MetaPixel from "./components/MetaPixel";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body className="antialiased">
        <Suspense fallback={null}>
          <MetaPixel />
        </Suspense>

        <Script
          async
          src="https://www.googletagmanager.com/gtag/js?id=AW-769471741"
          strategy="afterInteractive"
        />
        <Script id="google-ads-gtag" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', 'AW-769471741');
          `}
        </Script>

        {children}
      </body>
    </html>
  );
}
