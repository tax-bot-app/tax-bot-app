import Link from "next/link";
import { faqItems } from "../lib/faqItems";

export const metadata = {
  title: "FAQ | さじかげん",
  description: "さじかげんのよくあるご質問です。",
};

export default function FaqPage() {
  return (
    <main className="legalPage">
      <div className="legalInner">
        <h1>FAQ</h1>
        <p className="legalLead">
          ご利用前によくいただく質問をまとめています。
        </p>

        <div className="faqList">
          {faqItems.map((item) => (
            <details key={item.q} className="faqItem">
              <summary className="faqSummary">{item.q}</summary>
              <div className="faqAnswer">
                {item.a.split("\n").map((line, i) => (
                  <p key={i}>{line}</p>
                ))}
              </div>
            </details>
          ))}
        </div>

        <div className="faqLinks">
          <Link href="/terms">利用規約</Link>
          <Link href="/privacy">プライバシーポリシー</Link>
        </div>
      </div>
    </main>
  );
}