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
  const a = stripLinesAndCatchphrase(full);
  if (!a) return "";

  const sec = extractSection(a, "🥄");  // 🥄先に言うと（本番のまま）
  const key = extractSection(a, "✅");  // ✅要点（最大2に削る）
  const warn = extractSection(a, "⚠️"); // ⚠️注意（最大1に削る）

  // 「締め」はセクション境界で切れないので、末尾から拾う（作文しない／拾うだけ）
  const linesAll = String(a ?? "").replace(/\r\n/g, "\n").split("\n");
  const markers = ["🥄", "✅", "⚠️", "🍚", "🧂", "👉", "🔎"];
  const isMarker = (l: string) => markers.some((m) => l.trimStart().startsWith(m));

  // 本文（🥄/✅/⚠️）に既に出ている行は、締めとして拾わない（重複防止）
  const norm = (s: string) =>
    String(s ?? "")
      .trim()
      .replace(/\*\*/g, "")          // 太字を無視して比較
      .replace(/^[🥄✅⚠️]\s*/u, "")  // 先頭マーカー無視
      .replace(/^[-・*]\s*/u, "")    // 箇条書き無視
      .trim();

  const seenCore = new Set<string>();
  for (const l of [...sec, ...key, ...warn]) {
    const k = norm(l);
    if (k) seenCore.add(k);
  }

  const tailLines: string[] = [];
  for (let i = linesAll.length - 1; i >= 0 && tailLines.length < 3; i--) {
    const raw = linesAll[i] ?? "";
    const t = raw.trim();
    if (!t) continue;
    if (isMarker(t)) continue;
    if (t.startsWith("-") || t.startsWith("・") || t.startsWith("※")) continue;

    // 本文と同じ行（結論の再掲など）は落とす
   const k = norm(t);
    if (k && seenCore.has(k)) continue;

    tailLines.unshift(raw.trimEnd());
  }

  // 質問行が取れてるなら、「例 …」はノイズになりやすいので落とす（任意だが今回の崩れ防止に効く）
  const hasQuestion = tailLines.some((l) => /[?？]\s*$/.test(l.trim()));
  const tailLinesFinal = hasQuestion
    ? tailLines.filter((l) => !/^例\b|^例[：:]/.test(l.trim()))
    : tailLines;

  // ✅要点：箇条書きだけを最大2
  const keyBullets = pickBullets(key, 2);
  // ⚠️注意：箇条書き/本文を最大1（※は残す）
  const warnBullets = pickBullets(warn, 1);

  const out: string[] = [];
  if (sec.length) out.push(...sec.map((l) => l.trimEnd()));
  if (key.length) {
    // ✅見出し行だけ残し、本文は bullet2に再構成
    out.push("", key[0].trimEnd());
    for (const b of keyBullets) out.push(`- ${b}`);
  }
  if (warnBullets[0]) {
    // ⚠️見出し行は残す（あれば）
    const warnHead = warn.find((l) => l.trimStart().startsWith("⚠️")) ?? "⚠️注意";
    out.push("", warnHead.trimEnd());
    out.push(String(warnBullets[0]).trimStart().startsWith("※") ? warnBullets[0] : `※ ${warnBullets[0]}`);
  }

  // 締め：本番の締めがあれば最大3行だけ残す。無ければ保険を1行。
  const tailPicked = tailLinesFinal.slice(0, 3);
  if (tailPicked.length) {
    out.push("", ...tailPicked);
  } else {
    out.push("", "もう一段、運用まで掘り下げますか？");
  }

  let s = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
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
