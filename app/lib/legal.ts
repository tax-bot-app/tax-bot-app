// app/lib/legal.ts
import fs from "node:fs";
import path from "node:path";

function readLegalFile(filename: string): string {
  const filePath = path.join(process.cwd(), "content", "legal", filename);
  return fs.readFileSync(filePath, "utf8");
}

export function getTermsMarkdown(): string {
  return readLegalFile("terms.md");
}

export function getPrivacyMarkdown(): string {
  return readLegalFile("privacy.md");
}

export function getCommerceMarkdown(): string {
  return readLegalFile("commerce.md");
}