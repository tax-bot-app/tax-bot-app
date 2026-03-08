// app/terms/page.tsx
import ReactMarkdown from "react-markdown";
import { getTermsMarkdown } from "../lib/legal";

export const metadata = {
  title: "利用規約 | さじかげん",
  description: "さじかげんの利用規約です。",
};

export default function TermsPage() {
  const content = getTermsMarkdown();

  return (
    <main className="legalPage">
      <div className="legalInner legalMarkdown">
        <h1>利用規約</h1>
        <p className="legalLead">
          本ページは「さじかげん」の利用規約です。
        </p>

        <ReactMarkdown>{content}</ReactMarkdown>
      </div>
    </main>
  );
}