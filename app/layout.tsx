import { Suspense } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { Yuji_Syuku } from "next/font/google";
import "./globals.css";
import MetaPixel from "./components/MetaPixel";

export const yuji = Yuji_Syuku({
  subsets: ["latin"],
  weight: "400",
});

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <Suspense fallback={null}>
          <MetaPixel />
        </Suspense>
        {children}
      </body>
    </html>
  );
}