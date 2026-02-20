// app/api/demo-chat/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { judgeGuardrails } from "../../lib2/guardrails";
import { buildAnswerCore } from "../chat/route";

export const runtime = "nodejs";

type DemoRes =
  | { ok: true; answer: string }
  | { ok: false; error: string };

const DEMO_MAX_INPUT = 400;
const DEMO_MAX_OUTPUT = 750;

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function extractSection(answer: string, head: "🥄" | "✅" | "⚠️"): string[] {
  const lines = String(answer ?? "").replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inSec = false;
  const markers = ["🥄", "✅", "⚠️", "🍚", "🧂", "👉", "🔎"];

  for (const line of lines) {
    const t = line.trimStart();
    if (t.startsWith(head)) {
      inSec = true;
      out.push(line.trimEnd());
      continue;
    }
    if (inSec) {
      if (markers.some((m) => t.startsWith(m))) break;
      out.push(line.trimEnd());
    }
  }
  while (out.length > 0 && !out[out.length - 1].trim()) out.pop();
  return out;
}

function stripHeadLine(line: string): string {
  let t = (line ?? "").trim();

   // 先頭の絵文字を落とす（壊れサロゲートも吸収）
  // 🥄 = \uD83E\uDD44 だが、\uDD44 だけ残る事故があるので両方落とす
  t = t.replace(/^(?:🥄|✅|⚠️|\uD83E|\uDD44)\s*/u, "");

  // 「先に言うと：」「要点：」「注意：」みたいなラベルがあれば落とす
  const m = t.match(/^.{0,18}[：:]\s*(.+)$/);
  if (m?.[1]) t = m[1].trim();

  // ラベル単体は“中身なし”扱い（demoで見せる価値ゼロ）
  t = t.replace(/^(先に言うと|要点|注意)\s*$/u, "").trim();

  return t.trim();
}

function pickBullets(lines: string[], max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    let t = (line ?? "").trim();
    if (!t) continue;

    // 見出し行（✅要点 ... / ⚠️注意 ...）も中身があれば拾う
    if (/^[✅⚠️]/.test(t)) {
      t = stripHeadLine(t);
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
      if (out.length >= max) break;
      continue;
    }

    // 箇条書き
    t = t.replace(/^[-・*]\s*/, "").trim();
    if (!t) continue;

    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
    if (out.length >= max) break;
  }

  return out.slice(0, max);
}

function stripLinesAndCatchphrase(text: string): string {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");

  const out = lines.filter((line) => {
    const t = line.trimStart();
    // Lines（🍚🧂）は出さない
    if (t.startsWith("🍚") || t.startsWith("🧂")) return false;
    // 合言葉CTAはデモでは邪魔
    if (/攻め守りで|さじかげんよろ|さじかげんよろしく/.test(t)) return false;
    return true;
  });

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function toDemoAnswer(full: string): string {
  let a = stripLinesAndCatchphrase(full);
  if (!a) return "";

  const sec = extractSection(a, "🥄");
  const key = extractSection(a, "✅");
  const warn = extractSection(a, "⚠️");

  const out: string[] = [];

  const looksPoliteEnd = (s: string) => /(です|ます|だ|でしょう|します|できます|OK|大丈夫)\s*[。！!]?$/u.test((s ?? "").trim());
  const ensurePeriod = (s: string) => {
    const t = (s ?? "").trim();
    if (!t) return "";
    if (/[。.!！]$/.test(t)) return t;
    return `${t}。`;
  };

  // 結論を“会話っぽく”整える（名詞列→「まずは〜が基本です」）
  const softenConcl = (s: string) => {
    let t = (s ?? "").trim();
    if (!t) return "";
    // すでに会話文っぽいなら触らない
    if (looksPoliteEnd(t) || /^(まず|結論|要は|ポイントは)/u.test(t)) return ensurePeriod(t);
    // 名詞列（スラッシュ・列挙）っぽい時は「まずは〜が基本です」に寄せる
    if (/[／/・]/u.test(t) || /日付|相手先|金額|目的|業務/u.test(t)) {
      t = `まずは、${t}を残すのが基本です`;
      return ensurePeriod(t);
    }
    // それ以外は「まずは〜が無難です」
    t = `まずは、${t}が無難です`;
    return ensurePeriod(t);
  };

  // “最後の質問”を抽出（LLMが書いてたらそれを採用）
  const findLastQuestion = (text: string) => {
    const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
    const tail = lines.slice(Math.max(0, lines.length - 12));
    for (let i = tail.length - 1; i >= 0; i--) {
      const raw = tail[i]?.trim();
      if (!raw) continue;
      if (/[?？]$/.test(raw)) return raw;
    }
    return "";
  };
  // 1) 結論
  const conclRaw =
    (sec.find((l) => l.trim()) ? stripHeadLine(sec.find((l) => l.trim())!) : "") ||
    (key.find((l) => l.trim()) ? stripHeadLine(key.find((l) => l.trim())!) : "") ||
    "";
  const concl = conclRaw || (pickBullets(key, 1)[0] ?? "");
  if (concl) {
    out.push("☞ 結論：");
    out.push(softenConcl(concl));
  }

  // 2) 通す条件（要点 3）
  let keyBullets = pickBullets(key, 3).filter((b) => b && b !== concl);

  // ✅ 最低保証：通す条件は原則2つ（長くしない）
  // ✅要点が薄い時は、結論文を分割して補う
  if (keyBullets.length < 2 && concl) {
    const parts = concl
      .split(/[、。・\/]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => s.length >= 8)
      .slice(0, 3);
    for (const p of parts) {
      if (keyBullets.length >= 2) break;
      if (!keyBullets.includes(p) && p !== concl) keyBullets.push(p);
    }
  }

  // それでも足りない場合だけ、注意から“条件っぽい”ものを1つだけ拾う（説教/違法断りは除外）
  if (keyBullets.length < 2) {
    const w = pickBullets(warn, 2)
      .filter((x) => x && !/(絶対|やらないで|違法|脱税|払っていない|売上抜き)/.test(x));
    if (w[0] && !keyBullets.includes(w[0])) keyBullets.push(w[0]);
  }

  // 表示（最大2つまでで短く固定）
  if (keyBullets.length) {
    out.push("", "☞ 通す条件：");
    for (const b of keyBullets.slice(0, 2)) out.push(`- ${b}`);
  }

  // 3) 注意（最大1）
  const warnBullets = pickBullets(warn, 1);
  if (warnBullets[0]) {
    out.push("", "☞ 注意：");
    out.push(`※ ${warnBullets[0]}`);
  }

  // 4) 具体例（できれば1つ）
  // いまはLLM側に「具体例を1つ」要求してるので、ここは “拾う” だけにする。
  // 例っぽい行（「例えば」「例：」「たとえば」）がどこかにあれば1行拾う。
  const allLines = a.split("\n").map((x) => x.trim()).filter(Boolean);
  const ex = allLines.find((l) => /(例えば|たとえば|例：|例:)/.test(l));
  if (ex) {
    out.push("", "☞ 具体例：");
    out.push(ex.replace(/^(?:例えば|たとえば)\s*[：:]\s*/,"").trim());
  }

  // 5) 末尾の質問（ラベル無しで1行だけ）
  const lastQ = findLastQuestion(a);
  const hasQAlready = out.some((l) => /[?？]\s*$/.test(String(l ?? "").trim()));
  if (!hasQAlready) {
    out.push("");
    out.push(
      lastQ ||
        "もう一段、運用まで掘り下げますか？"
    );
  }

  let s = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!s) s = a.split("\n").slice(0, 6).join("\n").trim();

  if (s.length > DEMO_MAX_OUTPUT) s = s.slice(0, DEMO_MAX_OUTPUT).trimEnd() + "…";
  return s;
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const message = String(body?.message ?? "").trim();

    if (!message) {
      return NextResponse.json({ ok: false, error: "message is required" } satisfies DemoRes, { status: 400 });
    }
    if (message.length > DEMO_MAX_INPUT) {
      return NextResponse.json(
        { ok: false, error: `デモは ${DEMO_MAX_INPUT} 文字までです。` } satisfies DemoRes,
        { status: 400 }
      );
    }

    const gr = judgeGuardrails(message);
    if (gr.action === "block") {
      return NextResponse.json({ ok: true, answer: String(gr.userMessage ?? "").trim() } satisfies DemoRes);
    }

    // demo はログイン無しなので service role 推奨（RLSでknowledgeを読めない環境だとQA採用が死ぬ）
    const url = mustEnv("NEXT_PUBLIC_SUPABASE_URL");
    const key =
      process.env.SUPABASE_SERVICE_ROLE_KEY || mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

    const db = createClient(url, key, { auth: { persistSession: false } });

    const topicMode: "regex" | "llm" =
      (process.env.TOPIC_MODE || "regex") === "llm" ? "llm" : "regex";

    // demoは単発扱い：conv/userはダミーでOK（persistDebug=falseなのでDBに残らない）
    const convId = crypto.randomUUID();
    const userId = crypto.randomUUID();

    const core = await buildAnswerCore({
      mode: "demo",
      db,
      userId,
      convId,
      message,
      dialect: "standard",
      stance: "sanbo",
      gr,
      topicMode,
      persistDebug: false,
    });

    const answer = toDemoAnswer(core.answer);

    if (!answer) {
      return NextResponse.json({ ok: false, error: "AI returned empty response" } satisfies DemoRes, { status: 502 });
    }

    return NextResponse.json({ ok: true, answer } satisfies DemoRes);
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? String(e) } satisfies DemoRes,
      { status: 500 }
    );
  }
}
