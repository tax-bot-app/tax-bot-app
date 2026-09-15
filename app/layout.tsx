import { Suspense } from "react";
import Script from "next/script";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource/yuji-syuku/japanese-400.css";
import "./globals.css";
import MetaPixel from "./components/MetaPixel";

const OPENAI_ADS_PIXEL_ID = process.env.NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID?.trim();

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

        {OPENAI_ADS_PIXEL_ID && (
          <Script id="openai-ads-pixel-base" strategy="afterInteractive">
            {`
              !function(w,d,s,u,p){
                if(w.__sajikagenOpenAIAdsPixelInitialized)return;
                if(!w.oaiq){
                  var q=function(){q.q.push(arguments)};
                  q.q=[];
                  w.oaiq=q;
                  var j=d.createElement(s);
                  j.async=1;
                  j.src=u;
                  var f=d.getElementsByTagName(s)[0];
                  f.parentNode.insertBefore(j,f);
                }
                w.oaiq("init",{pixelId:p});
                w.__sajikagenOpenAIAdsPixelInitialized=true;
              }(window,document,"script","https://bzrcdn.openai.com/sdk/oaiq.min.js",${JSON.stringify(OPENAI_ADS_PIXEL_ID)});
            `}
          </Script>
        )}

        {children}
      </body>
    </html>
  );
}
