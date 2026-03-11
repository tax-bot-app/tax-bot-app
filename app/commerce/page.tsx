import ReactMarkdown from "react-markdown";
import { getCommerceMarkdown } from "../lib/legal";

export const metadata = {
  title: "販売・提供条件（特定商取引法に準ずる表示） | さじかげん",
  description: "さじかげんの販売条件、提供条件および事業者情報です。",
};

export default function CommercePage() {
  const content = getCommerceMarkdown();

  return (
    <main className="legalPage">
      <div className="legalInner legalMarkdown">
        <h1>販売・提供条件（特定商取引法に準ずる表示）</h1>
        <p className="legalLead">
          本ページは「さじかげん」の販売条件、提供条件およびお問い合わせ先をまとめたものです。
        </p>

        <ReactMarkdown>{content}</ReactMarkdown>
      </div>
    </main>
  );
}