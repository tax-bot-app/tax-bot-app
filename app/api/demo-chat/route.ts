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
const DEMO_COOKIE = "sjk_demo_done";
const DEMO_TIMEOUT_MS = 60_000;

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function hasDemoCookie(cookieHeader: string | null): boolean {
  const c = cookieHeader ?? "";
  return /(?:^|;\s*)sjk_demo_done=1(?:;|$)/.test(c);
}

function setDemoCookie(res: NextResponse) {
  // 30日。ここは好みで。
  res.cookies.set(DEMO_COOKIE, "1", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

function extractSection(answer: string, head: "🥄" | "✅" | "⚠️"): string[] {
  const lines = String(answer ?? "").replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inSec = false;
  const markers = ["🥄", "✅", "⚠️", "🍚", "🧂", "👉", "🔎", "（〆）", "(〆)", "〆"];

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

function dedupeConsecutiveBlocks(text: string): string {
  const s = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!s) return s;

  const blocks = s
    .split(/\n{2,}/g)
    .map((b) => b.trim())
    .filter(Boolean);

  const norm = (b: string) =>
    b
      .replace(/\*\*/g, "")
      .replace(/[ 　\t]+/g, " ")
      .replace(/\n+/g, "\n")
      .trim();

  const out: string[] = [];
  let prev = "";
  for (const b of blocks) {
    const k = norm(b);
    if (!k) continue;
    if (k === prev) continue; // 連続重複だけ落とす（離れた重複は残す）
    out.push(b);
    prev = k;
  }

  return out.join("\n\n").trim();
}


function toDemoAnswer(full: string): string {
  const a = stripLinesAndCatchphrase(full);
  const a2 = dedupeConsecutiveBlocks(a);
  if (!a2) return "";

  const sec = extractSection(a2, "🥄");  // 🥄先に言うと（本番のまま）
  const key = extractSection(a2, "✅");  // ✅要点（最大2に削る）
  const warn = extractSection(a2, "⚠️"); // ⚠️注意（最大1に削る）

  // 「締め」はセクション境界で切れないので、末尾から拾う（作文しない／拾うだけ）
  const linesAll = String(a2 ?? "").replace(/\r\n/g, "\n").split("\n");
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
  // 🥄と✅はそのままコア扱い
  for (const l of [...sec, ...key]) {
    const k = norm(l);
    if (k) seenCore.add(k);
  }
  // ⚠️は末尾の締めまで吸い込みやすいので、
  // 「⚠️見出し / ※行 / 箇条書き」だけコア扱いにする（締め文を弾きすぎない）
  for (const l of warn) {
    const t0 = String(l ?? "").trimStart();
    const isWarnBody = t0.startsWith("⚠️") || t0.startsWith("※") || /^[-・*]\s*/.test(t0);
    if (!isWarnBody) continue;
    const k = norm(t0);
    if (k) seenCore.add(k);
  }

  // 締めっぽい行（質問・次アクション）を優先で拾う
  const looksLikeClose = (t: string) => {
    const s = t.trim();
    if (!s) return false;
    if (/[?？]\s*$/.test(s)) return true;
    if (/(ですか|ますか|でしょうか)\s*[。．.]?\s*$/.test(s)) return true;
    if (/(教えて|言うて|どっち|どちら|追加|前提|掘り下げ|もう一段|もう少し|続き|つづき|気になる)/.test(s)) return true;
    return false;
  };

  const tailLines: string[] = [];

  // ① まず「締めっぽい行」を最大3行拾う（※や箇条書きでもOK）
  for (let i = linesAll.length - 1; i >= 0 && tailLines.length < 3; i--) {
    const raw = linesAll[i] ?? "";
    const t0 = raw.trim();
    if (!t0) continue;
    if (isMarker(t0)) continue;

    // ※ / 箇条書きは剥がして判定（ただし表示は剥がした後を使う）
    const t = t0.replace(/^[-・*]\s*/u, "").replace(/^※\s*/u, "").trim();

    const k = norm(t);
    if (k && seenCore.has(k)) continue;

    if (looksLikeClose(t)) tailLines.unshift(t);
  }

  // ② 取れなければ、末尾の普通文を最大2行拾う（保険）
  if (tailLines.length === 0) {
    for (let i = linesAll.length - 1; i >= 0 && tailLines.length < 2; i--) {
      const raw = linesAll[i] ?? "";
      const t0 = raw.trim();
      if (!t0) continue;
      if (isMarker(t0)) continue;
      if (t0.startsWith("※")) continue;
      if (t0.startsWith("-") || t0.startsWith("・")) continue;

      const k = norm(t0);
      if (k && seenCore.has(k)) continue;

      tailLines.unshift(t0);
    }
  }

  // ③ 質問行が取れてるなら「例…」は落とす
  const hasQuestion = tailLines.some((l) => /[?？]\s*$/.test(l.trim()));
  const tailLinesFinal = hasQuestion
    ? tailLines.filter((l) => !/^例(?:\s|[：:])/u.test(l.trim()))
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
    // ✅ サーバ側でも「デモ1回のみ」を保証（フロントのCookie制限だけだと抜ける）
    if (hasDemoCookie(req.headers.get("cookie"))) {
      return NextResponse.json(
        { ok: false, error: "無料体験は1回のみです。プラン確認から続けられます。" } satisfies DemoRes,
        { status: 409 }
      );
    }
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
      // block でも「1回消費」扱いにする（抜け道防止）
      const res = NextResponse.json({ ok: true, answer: String(gr.userMessage ?? "").trim() } satisfies DemoRes);
      setDemoCookie(res);
      return res;
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

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort("DEMO_TIMEOUT"), DEMO_TIMEOUT_MS);
    let core;
    try {
      core = await buildAnswerCore({
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
        signal: ac.signal, // ★追加
      });
    } finally {
      clearTimeout(t);
    }

    const answer = toDemoAnswer(core.answer);

    if (!answer) {
      return NextResponse.json({ ok: false, error: "AI returned empty response" } satisfies DemoRes, { status: 502 });
    }

    const res = NextResponse.json({ ok: true, answer } satisfies DemoRes);
    setDemoCookie(res);
    return res;
  } catch (e: any) {
    const msg = String(e?.message ?? "");
    const aborted =
      e?.name === "AbortError" ||
      /aborted/i.test(msg) ||
      msg.includes("DEMO_TIMEOUT") ||
      String(e?.cause ?? "").includes("DEMO_TIMEOUT");

      // ★追加：Abort以外の500原因をVercelログに出す
    if (!aborted) console.error("[demo-chat]", e);

    if (aborted) {
      return NextResponse.json(
        { ok: false, error: "混み合っています。少し時間をおいて、もう一度お試しください。" } satisfies DemoRes,
        { status: 504 }
      );
    }
    // 生エラーは返さない（内部情報っぽく見えるしUXも悪い）
    return NextResponse.json(
      { ok: false, error: "エラーが発生しました。内容を少し変えて再送してください。" } satisfies DemoRes,
      { status: 500 }
    );
  }
}
