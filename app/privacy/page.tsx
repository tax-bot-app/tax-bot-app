// app/privacy/page.tsx
import { getPrivacyMarkdown } from "../lib/legal";

export const metadata = {
  title: "プライバシーポリシー | さじかげん",
  description: "さじかげんのプライバシーポリシーです。",
};

export default function PrivacyPage() {
  const content = getPrivacyMarkdown();

  return (
    <main className="legalPage">
      <div className="legalInner">
        <h1>プライバシーポリシー</h1>
        <p className="legalLead">
          本ページは「さじかげん」における個人情報等の取扱いを定めるものです。
        </p>

        <pre className="legalPre">{content}</pre>
      </div>
    </main>
  );
}