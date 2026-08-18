"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { getSupabaseClient } from "./lib/supabaseClient";
import { trackDemoStart, trackInitiateCheckout, trackPlanView } from "./lib/metaPixel";

type Plan = "lite" | "standard" | "enterprise";

const PLANS: Array<{
  key: Plan;
  title: string;
  priceLabel: string;
  quotaLabel: string;
  note?: string;
}> = [
  { 
  key: "lite", 
  title: "Lite", 
  priceLabel: "月額1,480円（税込）", 
  quotaLabel: "月5回まで", 
  note: "まずは様子見で始めたい方へ。確認や不安の切り分けに。※いつでもアップグレード可能。" 
},
{ 
  key: "standard", 
  title: "Standard", 
  priceLabel: "月額4,800円（税込）", 
  quotaLabel: "月30回まで", 
  note:  "一番選ばれているプラン。自社向けの具体的な線引きまで整理したい方へ。"
},
{ 
  key: "enterprise", 
  title: "Enterprise", 
  priceLabel: "月額9,800円（税込）", 
  quotaLabel: "月100回まで", 
  note: "複数担当・継続運用向け。社内共有や定例相談の補助に。" 
},
];

const PLAN_META_PRICE: Record<Plan, number> = {
  lite: 1480,
  standard: 4800,
  enterprise: 9800,
};

type CheckoutRes = { ok: true; url: string } | { ok: false; error: string };
type DemoRes =
  | { ok: true; answer: string; usedAttempts: number }
  | { ok: false; error: string; usedAttempts?: number };

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

const DEMO_COOKIE_KEY = "sajikagen_demo_done";
const DEMO_LS_KEY = "sajikagen_demo_done";
const DEMO_BYPASS_LS = "sjk_demo_bypass";
const DEMO_MAX_LEN = 400;
const DEMO_MAX_ATTEMPTS = 3;

function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}
function setCookie(name: string, value: string, days = 365) {
  if (typeof document === "undefined") return;
  const expires = new Date(Date.now() + days * 86400 * 1000).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; Expires=${expires}; Path=/; SameSite=Lax`;
}

function parseDemoCount(value: string | null): number {
  const count = Number.parseInt(value ?? "0", 10);
  return Number.isFinite(count) ? Math.min(Math.max(count, 0), DEMO_MAX_ATTEMPTS) : 0;
}

function getDemoCountByCookieOrLS(): number {
  const cookieCount = parseDemoCount(getCookie(DEMO_COOKIE_KEY));
  let localCount = 0;
  try { localCount = parseDemoCount(localStorage.getItem(DEMO_LS_KEY)); } catch {}
  return Math.max(cookieCount, localCount);
}

function markDemoCountCookieAndLS(count: number) {
  const safeCount = Math.min(Math.max(Math.trunc(count), 0), DEMO_MAX_ATTEMPTS);
  setCookie(DEMO_COOKIE_KEY, String(safeCount), 180);
  try { localStorage.setItem(DEMO_LS_KEY, String(safeCount)); } catch {}
}

async function getDeviceId(): Promise<string | null> {
  try {
    const mod = await import("@fingerprintjs/fingerprintjs");
    const fp = await mod.load();
    const r = await fp.get();
    return r?.visitorId ? String(r.visitorId) : null;
  } catch {
    return null;
  }
}

export default function Home() {
  const demoRef = useRef<HTMLElement | null>(null);
  const demoInputRef = useRef<HTMLTextAreaElement | null>(null);
  const plansRef = useRef<HTMLElement | null>(null);

  const [fatal, setFatal] = useState<string | null>(null);

  // menu
  const [menuOpen, setMenuOpen] = useState(false);

  // demo
  const [demoInput, setDemoInput] = useState("");
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoDots, setDemoDots] = useState("");
  const [demoUsed, setDemoUsed] = useState(0);
  const demoDone = demoUsed > 0;
  const demoLimitReached = demoUsed >= DEMO_MAX_ATTEMPTS;
  const [demoAnswer, setDemoAnswer] = useState<string | null>(null);
  const [demoError, setDemoError] = useState<string | null>(null);
  const [demoAnsweredThisSession, setDemoAnsweredThisSession] = useState(false);

  // plans
  const [agreed, setAgreed] = useState(false);
  const [plansOpen, setPlansOpen] = useState(false);
  const [busyPlan, setBusyPlan] = useState<Plan | null>(null);

  const supabase = useMemo(() => {
    try {
      return getSupabaseClient();
    } catch (e: any) {
      setFatal(
        `環境変数が足りません：${e?.message ?? String(e)}\n` +
          `VercelのEnvironment Variablesに NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を入れて、Redeployしてください。`
      );
      return null;
    }
  }, []);

  // init: cookie
  useEffect(() => {
    const used = getDemoCountByCookieOrLS();
    setDemoUsed(used);
    const showPlans = new URLSearchParams(window.location.search).get("plans") === "1";
    if (used > 0 || showPlans) {
      setPlansOpen(true);
    }
    if (showPlans) {
      window.setTimeout(() => plansRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
    }
  }, []);

    useEffect(() => {
    let cvFired = false;

    const observer = new MutationObserver((mutations) => {
      if (cvFired) return;

      for (const mutation of mutations) {
        for (const node of Array.from(mutation.addedNodes)) {
          if (!(node instanceof HTMLElement)) continue;

          const text = node.innerText || node.textContent || "";
          if (text.includes("いま内容を整理しています")) {
            if (typeof window !== "undefined" && typeof window.gtag === "function") {
              window.gtag("event", "conversion", {
                send_to: "AW-769471741/fFy4CIzs9pwcEP3p9O4C",
              });
            }

            cvFired = true;
            observer.disconnect();
            return;
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    return () => observer.disconnect();
  }, []);

  // close menu on outside click / esc
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest?.("[data-menu-root]")) return;
      setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, []);

  // ✅ 送信中の「…」をムービング（止まってない感）
  useEffect(() => {
    if (!demoBusy) {
      setDemoDots("");
      return;
    }
    let i = 0;
    const id = window.setInterval(() => {
      i = (i + 1) % 4; // "", ".", "..", "..."
      setDemoDots(".".repeat(i));
    }, 350);
    return () => window.clearInterval(id);
  }, [demoBusy]);

  const scrollTo = (el: HTMLElement | null) => {
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const onClickFreeTry = () => scrollTo(demoRef.current);

  const onClickExampleTry = () => {
    scrollTo(demoRef.current);
    window.setTimeout(() => demoInputRef.current?.focus(), 500);
  };

  const onClickShowPlans = () => {
    setPlansOpen(true);
    setTimeout(() => scrollTo(plansRef.current), 50);
  };

  const submitDemo = async () => {
    setDemoError(null);
    setDemoAnsweredThisSession(false);
    if (demoLimitReached) {
      setDemoAnswer("無料体験は3回までです。続きはプランから整理できます。");
      setPlansOpen(true);
      return;
    }

    const q = (demoInput ?? "").trim();
    if (!q) {
      setDemoError("相談内容を1行でいいので入れてください。");
      return;
    }
    if (q.length > DEMO_MAX_LEN) {
      setDemoError(`デモは ${DEMO_MAX_LEN} 文字までにしてます（本番はもっといける）。`);
      return;
    }

    setDemoBusy(true);

    // ★追加：待機メッセージ（先に見せる）
  setDemoAnswer("いま内容を整理しています。30秒〜1分ほどお待ちください。");
  setDemoError(null);

    try {
const bypass = (() => {
        try { return (localStorage.getItem(DEMO_BYPASS_LS) ?? "").trim(); } catch { return ""; }
      })();

      const deviceId = await getDeviceId(); // 取れなければ null（=弱い制限へ）

      const res = await fetch("/api/demo-chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(bypass ? { "x-demo-bypass": bypass } : {}),
        },
        body: JSON.stringify({ message: q, demo: true, deviceId }),
      });

      const json = (await res.json().catch(() => null)) as DemoRes | null;
      if (!json) throw new Error("demo-chat: empty response");
      if (!json.ok) {
        // 409 は「送信済み」扱いに寄せる（入力欄消す＋プラン開く）
        if (res.status === 409) {
          const usedAttempts = json.usedAttempts ?? DEMO_MAX_ATTEMPTS;
          setDemoUsed(usedAttempts);
          setPlansOpen(true);        // プランは開く（スクロールしない）
          markDemoCountCookieAndLS(usedAttempts);
          setDemoAnswer("無料体験は3回までです。続きはプランから整理できます。");
          setDemoError(null);        // 赤枠を出さない
          return;
        }
        throw new Error(json.error || "demo-chat failed");
      }

      setDemoAnswer(json.answer);
      setDemoUsed(json.usedAttempts);
      setDemoAnsweredThisSession(true);
      markDemoCountCookieAndLS(json.usedAttempts);

      // ✅ デモ回答表示後は、ユーザーの視線を回答に固定（自動スクロールしない）
      setPlansOpen(true); // プランは開くだけ（スクロールはしない）
       trackDemoStart();
      trackPlanView();
    } catch (e: any) {
      setDemoError(`送信に失敗しました：${e?.message ?? String(e)}`);
    } finally {
      setDemoBusy(false);
    }
  };

  const goCheckout = async (plan: Plan) => {
    if (!supabase) {
      alert("初期化に失敗しています（Supabase環境変数を確認）");
      return;
    }
    if (!agreed) {
      alert("利用規約への同意が必要です。");
      return;
    }

    setBusyPlan(plan);
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session?.access_token) {
        window.location.href = `/login?plan=${encodeURIComponent(String(plan))}`;
        return;
      }

      trackInitiateCheckout(plan, PLAN_META_PRICE[plan]);
      
      // ログイン済みなら /checkout に統一（新規登録→認証後の導線と同じ）
      window.location.href = `/checkout?plan=${encodeURIComponent(String(plan))}`;
    } catch (e: any) {
      alert(`決済に進めません：${e?.message ?? String(e)}`);
    } finally {
      setBusyPlan(null);
    }
  };

  const styles: Record<string, React.CSSProperties> = {
    wrap: {
      minHeight: "100vh",
      background: "radial-gradient(circle at 78% 12%, rgba(197,151,65,0.08), transparent 30%), #F8F4EC",
      color: "#112B46",
    },
    container: { maxWidth: 1180, margin: "0 auto", padding: "0 24px 80px" },

    header: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      padding: "16px 0",
      position: "sticky",
      top: 0,
      background: "rgba(248,244,236,0.94)",
      backdropFilter: "blur(10px)",
      zIndex: 10,
      borderBottom: "1px solid rgba(176,132,52,0.28)",
    },
    brand: { display: "flex", alignItems: "center", gap: 10, textDecoration: "none", color: "#112B46" },
    brandLogo: { height: 26, width: "auto", display: "block" },

    nav: { display: "flex", alignItems: "center", gap: 10, position: "relative" },
    btnGhost: {
      border: "1px solid rgba(17,43,70,0.18)",
      background: "rgba(255,255,255,0.72)",
      color: "#112B46",
      borderRadius: 8,
      padding: "10px 12px",
      cursor: "pointer",
      fontWeight: 800,
      lineHeight: 1,
    },
    btnPrimary: {
      border: "1px solid #173A5E",
      background: "#173A5E",
      color: "#fff",
      borderRadius: 8,
      padding: "13px 18px",
      cursor: "pointer",
      fontWeight: 900,
      lineHeight: 1,
    },

    menu: {
      position: "absolute",
      top: 46,
      right: 0,
      background: "#fff",
      border: "1px solid #E6EAF2",
      borderRadius: 14,
      padding: 10,
      display: "grid",
      gap: 6,
      minWidth: 170,
      zIndex: 30,
      boxShadow: "0 18px 40px rgba(15, 23, 42, 0.10)",
    },
    menuItem: {
      padding: "10px 10px",
      borderRadius: 10,
      textDecoration: "none",
      color: "#0B1220",
      fontWeight: 800,
      fontSize: 13,
    },

    hero: {
      display: "flex",
      flexDirection: "column",
      padding: "54px 0 8px",
    },

    heroCard: {
      padding: 0,
      background: "transparent",
      boxShadow: "none",
      display: "flex",
      flexDirection: "column",
      justifyContent: "center",
    },
    h1: { fontSize: 44, lineHeight: 1.28, margin: 0, letterSpacing: "0.01em", color: "#112B46" },
    sub: { color: "rgba(17,43,70,0.76)", marginTop: 20, marginBottom: 0, lineHeight: 1.9 },

    heroActions: { display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" },

    // ✅ 角丸なし/影なし（貼り付け感を消すのは “SPフルブリード” で解決）
    heroImgBox: {
      border: 0,
      borderRadius: 18,
      overflow: "hidden",
      background: "#fff",
      minHeight: 230,
      maxHeight: 270,
      boxShadow: "0 16px 42px rgba(17,43,70,0.08)",
    },
    heroImg: { width: "100%", height: "100%", objectFit: "cover", objectPosition: "top center", display: "block" },

    aiCaptionWrap: { marginTop: 10 },
    aiCaptionTitle: { fontWeight: 950, fontSize: 14, margin: 0, color: "#0B1220" },
    aiCaptionSub: { color: "rgba(11,18,32,0.72)", marginTop: 6, marginBottom: 0, lineHeight: 1.6, fontSize: 13 },

    section: { marginTop: 36 },
    sectionTitle: { fontSize: 18, margin: "0 0 12px", letterSpacing: "0.08em", color: "#112B46" },

    expertCard: {
      display: "grid",
      gridTemplateColumns: "88px 1fr",
      gap: 14,
      alignItems: "center",
      marginBottom: 12,
      padding: 14,
      borderRadius: 14,
      border: "1px solid rgba(176,132,52,0.30)",
      background: "rgba(255,255,255,0.74)",
    },
    expertPhoto: {
      width: 88,
      height: 88,
      borderRadius: 16,
      objectFit: "cover",
      objectPosition: "24% 42%",
      display: "block",
    },
    expertTitle: {
      margin: 0,
      fontSize: 16,
      fontWeight: 950,
      lineHeight: 1.5,
      color: "#112B46",
    },
    expertMeta: {
      margin: "5px 0 0",
      color: "rgba(11,18,32,0.72)",
      fontSize: 13,
      lineHeight: 1.7,
    },

    chatShell: {
      borderRadius: 16,
      border: "1px solid rgba(17,43,70,0.16)",
      background: "rgba(255,255,255,0.88)",
      overflow: "hidden",
      boxShadow: "0 24px 60px rgba(17,43,70,0.10)",
    },
    chatTop: {
      padding: "12px 14px",
      borderBottom: "1px solid rgba(176,132,52,0.24)",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
      background: "rgba(255,253,248,0.92)",
    },
    chatTopLeft: { display: "flex", alignItems: "center", gap: 10 },
    dot: { width: 9, height: 9, borderRadius: 99, background: "#B58A3A" },
    chatBody: { padding: 14, display: "grid", gap: 10 },

    bubbleBot: {
      justifySelf: "start",
      maxWidth: "95%",
      padding: "10px 12px",
      borderRadius: 16,
      background: "#F6F7FB",
      border: "1px solid #E6EAF2",
      whiteSpace: "pre-wrap",
      lineHeight: 1.7,
      color: "rgba(11,18,32,0.92)",
      position: "relative",
      overflow: "hidden",
    },

    // demoBusy中だけ被せる“流れるハイライト”
    bubbleShimmer: {
      position: "absolute",
      inset: 0,
      background:
        "linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.45) 50%, rgba(255,255,255,0) 100%)",
      transform: "translateX(-120%)",
      animation: "sjkShimmer 1.2s infinite",
      pointerEvents: "none",
    },

    bubbleUser: {
      justifySelf: "end",
      maxWidth: "90%",
      padding: "10px 12px",
      borderRadius: 16,
      background: "rgba(23,58,94,0.08)",
      border: "1px solid rgba(23,58,94,0.16)",
      whiteSpace: "pre-wrap",
      lineHeight: 1.6,
      color: "#0B1220",
    },

    inputRow: {
      padding: 12,
      borderTop: "1px solid #E6EAF2",
      display: "grid",
      gridTemplateColumns: "1fr auto",
      gap: 10,
      alignItems: "center",
      background: "#fff",
    },
    textarea: {
      width: "100%",
      minHeight: 44,
      maxHeight: 120,
      resize: "vertical",
      padding: "10px 12px",
      borderRadius: 14,
      border: "1px solid #D7DEEA",
      outline: "none",
      background: "#fff",
      color: "#0B1220",
      lineHeight: 1.6,
    },

    small: { color: "rgba(11,18,32,0.62)", fontSize: 12, lineHeight: 1.6, marginTop: 10 },

    exampleCard: {
      marginTop: 16,
      padding: "18px 16px",
      borderRadius: 14,
      border: "1px solid rgba(176,132,52,0.28)",
      background: "rgba(255,255,255,0.78)",
      boxShadow: "0 18px 44px rgba(17,43,70,0.06)",
    },
    exampleLabel: {
      margin: 0,
      color: "#9A7027",
      fontSize: 13,
      fontWeight: 900,
      letterSpacing: "0.03em",
    },
    exampleQuestion: {
      margin: "7px 0 0",
      fontSize: 20,
      lineHeight: 1.5,
      color: "#0B1220",
    },
    exampleAnswer: {
      marginTop: 14,
      paddingTop: 14,
      borderTop: "1px solid #E6EAF2",
      color: "rgba(11,18,32,0.84)",
      lineHeight: 1.8,
    },
    upgradeCard: {
      marginTop: 14,
      borderRadius: 18,
      border: "1px solid rgba(176,132,52,0.30)",
      background: "linear-gradient(180deg, rgba(197,151,65,0.10), rgba(255,255,255,0.94))",
      padding: "18px 16px",
    },
    upgradeTitle: {
      margin: 0,
      color: "#0B1220",
      fontSize: 18,
      fontWeight: 950,
      lineHeight: 1.5,
    },

    warn: {
      marginTop: 10,
      padding: 10,
      borderRadius: 14,
      background: "rgba(220, 38, 38, 0.06)",
      border: "1px solid rgba(220, 38, 38, 0.18)",
      color: "rgba(127, 29, 29, 0.92)",
      whiteSpace: "pre-wrap",
    },

    prePlanMessage: {
      marginTop: 26,
      textAlign: "center",
      borderRadius: 18,
      border: "1px solid #E6EAF2",
      background: "#fff",
      padding: "16px 14px",
      boxShadow: "0 18px 40px rgba(15, 23, 42, 0.06)",
    },
    prePlanTitle: { fontSize: 20, fontWeight: 950, margin: 0, color: "#0B1220" },
    prePlanSub: { color: "rgba(11,18,32,0.72)", marginTop: 8, marginBottom: 0, lineHeight: 1.7 },

    details: {
      border: "1px solid #E6EAF2",
      borderRadius: 18,
      background: "#fff",
      overflow: "hidden",
      boxShadow: "0 18px 40px rgba(15, 23, 42, 0.08)",
    },
    summary: {
      cursor: "pointer",
      padding: "14px 16px",
      listStyle: "none",
      fontWeight: 900,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
      background: "#fff",
      color: "#0B1220",
    },
    plansBody: { padding: "0 16px 16px" },
    agreeRow: { display: "flex", alignItems: "center", gap: 10, marginTop: 12, marginBottom: 10, flexWrap: "wrap" },

    planGrid: { display: "grid", gap: 10, marginTop: 10 },
    planBtn: {
      textAlign: "left",
      padding: 14,
      borderRadius: 16,
      border: "1px solid #E6EAF2",
      background: "#fff",
      color: "#0B1220",
      cursor: "pointer",
    },
    planTop: { display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" },
    badge: {
  fontSize: 12,
  padding: "4px 10px",
  borderRadius: 999,
  border: "1px solid rgba(201,162,39,0.35)",
  color: "#8A6D1F",
  background: "linear-gradient(180deg, #F8E9B0, #E9C96A)",
  fontWeight: 900,
  whiteSpace: "nowrap",
},

    footer: { marginTop: 40, color: "rgba(11,18,32,0.62)", fontSize: 12, lineHeight: 1.7 },
    footerTitle: { fontWeight: 900, color: "rgba(11,18,32,0.92)" },
  };

  return (
    <main style={styles.wrap}>
    <style>{`
      @keyframes sjkShimmer {
        0% { transform: translateX(-120%); }
        100% { transform: translateX(120%); }
      }
    `}</style>
      <div style={styles.container}>
        {/* Header */}
        <header style={styles.header}>
          <Link href="/" style={styles.brand} aria-label="じかげん">
            <img src="/sa-logo-header.png" alt="じかげん" style={styles.brandLogo} />
            <span style={{ fontWeight: 900, letterSpacing: "0.06em" }}>じかげん</span>
          </Link>

          <nav style={styles.nav} data-menu-root>
            <Link href="/login" style={{ ...styles.btnGhost, textDecoration: "none", display: "inline-block" }}>
              ログイン
            </Link>

            <button
              style={styles.btnGhost}
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="メニュー"
              aria-expanded={menuOpen}
            >
              ☰
            </button>

            {menuOpen && (
              <div style={styles.menu} role="menu" aria-label="メニュー">
                <Link
                  href="/faq"
                  style={styles.menuItem}
                  onClick={() => setMenuOpen(false)}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(30,94,255,0.06)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  FAQ
                </Link>
                <Link
                  href="/privacy"
                  style={{ ...styles.menuItem, whiteSpace: "nowrap" }}
                  onClick={() => setMenuOpen(false)}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(30,94,255,0.06)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  プライバシーポリシー
                </Link>
                <Link
                  href="/terms"
                  style={styles.menuItem}
                  onClick={() => setMenuOpen(false)}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(30,94,255,0.06)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  利用規約
                </Link>
                <Link
  href="/commerce"
  style={styles.menuItem}
  onClick={() => setMenuOpen(false)}
  onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(30,94,255,0.06)")}
  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
>
  販売・提供条件
</Link>
              </div>
            )}
          </nav>
        </header>

        <div className="introGrid">
        {/* Hero */}
        <section id="hero" style={styles.hero}>
          <div className="heroImgFullBleed" style={{ ...styles.heroImgBox, gridArea: "img" }}>
            <img src="/ai-noguchi-hero.PNG" alt="AI野口 ヒーロー" style={styles.heroImg} />
          </div>

          <div
  className="heroCapFullBleed"
  style={{ gridArea: "cap", ...styles.aiCaptionWrap, textAlign: "center" }}
>
  <p style={{ ...styles.aiCaptionTitle, fontSize: 16, marginBottom: 4 }}>
  大手ドラッグストアチェーン顧問
</p>
<p style={{ ...styles.aiCaptionSub, fontSize: 17, fontWeight: 900 }}>
  税理士 野口のAI
</p>
</div>

<div className="heroCopy" style={{ ...styles.heroCard, gridArea: "copy" }}>
  <p className="eyebrow">経営者のためのAI税務相談</p>
  <h1
  className="heroTitle"
  style={{
    ...styles.h1,
    textAlign: "left",
  }}
>
  <span style={{ display: "block" }}>税理士はそのまま。</span>
  <span style={{ display: "block" }}>相談だけ、もう一段。</span>
</h1>

            <p style={styles.sub}>
              税務判断を、税務調査の現実まで踏まえて整理する、
              <br className="desktopBreak" />
              経営者向けAI税務相談です。
            </p>

            <div style={styles.heroActions}>
              <button style={styles.btnPrimary} onClick={onClickFreeTry}>
                無料で相談してみる
              </button>
              <button style={styles.btnGhost} onClick={onClickShowPlans}>
                プランを確認する
              </button>
            </div>

            {/* ✅ 税務調査経験（場所はここで固定／ブロック無し） */}
            <p style={{ ...styles.small, marginTop: 10 }}>
              豊富な税務調査対応の経験を踏まえて、現実的な“揉めどころ”から整理します。
            </p>

            
            {fatal && <div style={styles.warn}>{fatal}</div>}
          </div>
        </section>

        {/* Demo */}
        <section
          ref={(el) => {
            demoRef.current = el;
          }}
          id="demo"
          style={styles.section}
        >
          <h2 style={styles.sectionTitle}>無料体験（3回）</h2>

          <div style={styles.expertCard}>
            <img
              src="/ai-noguchi-signup.PNG"
              alt="税理士 野口集平"
              style={styles.expertPhoto}
            />
            <div>
              <p style={styles.expertTitle}>税理士・野口集平の判断軸をもとに回答します</p>
              <p style={styles.expertMeta}>
                税理士法人GLADZ代表<br />
                大手ドラッグストアチェーン顧問税理士<br />
                法人税務・税務調査対応の実務経験をもとに、「できる・できない」だけでなく、現実的な線引きを整理します。
              </p>
            </div>
          </div>

          <div style={styles.chatShell}>
            <div style={styles.chatTop}>
              <div style={styles.chatTopLeft}>
                <div style={styles.dot} />
                <div style={{ fontWeight: 900 }}>さじかげん（デモ）</div>
              </div>
              <div style={{ color: "rgba(11,18,32,0.55)", fontSize: 12 }}>{demoUsed} / {DEMO_MAX_ATTEMPTS}回使用</div>
            </div>

            <div style={styles.chatBody}>
              {demoInput.trim() && <div style={styles.bubbleUser}>{demoInput.trim()}</div>}

                {demoAnswer && (
                <div style={styles.bubbleBot}>
                  {demoAnswer}
                  {demoBusy && <div style={styles.bubbleShimmer} />}
                </div>
              )}
                            
              {demoError && <div style={styles.warn}>{demoError}</div>}

              <div style={styles.small}>
                無料体験では、考え方の入口まで整理します。
              </div>
            </div>

            <div style={styles.inputRow}>
                <textarea
                  ref={demoInputRef}
                  value={demoInput}
                  onChange={(e) => setDemoInput(e.target.value)}
                  placeholder="相談内容を入力してください"
                  style={styles.textarea}
                  maxLength={DEMO_MAX_LEN + 20}
                  disabled={demoBusy || demoLimitReached}
                />
                <button
                  style={{
                    ...styles.btnPrimary,
                    opacity: demoBusy || demoLimitReached ? 0.6 : 1,
                    cursor: demoBusy || demoLimitReached ? "not-allowed" : "pointer",
                    padding: "12px 14px",
                  }}
                  onClick={submitDemo}
                  disabled={demoBusy || demoLimitReached}
                >
                  <span style={{ opacity: demoBusy ? 0.9 : 1 }}>
                    {demoBusy ? `送信中${demoDots}` : demoLimitReached ? "3回使用済み" : "送信"}
                  </span>
                </button>
              </div>
          </div>
        </section>
        </div>

        <section className="contentSection">
          <article style={styles.exampleCard} aria-labelledby="example-trip-allowance">
            <p style={styles.exampleLabel}>相談例・回答例</p>
            <h3 id="example-trip-allowance" style={styles.exampleQuestion}>
              出張日当を1日2万円にしても大丈夫ですか？
            </h3>

            <div style={styles.exampleAnswer}>
              <p style={{ margin: 0 }}>
                <strong>1日2万円は「高いから即NG」という金額ではありません。</strong>
                <br />
                ただし、社長だけ2万円で従業員との差が大きい場合や、近距離出張まで一律2万円にしている場合は、理由を説明できる設計が必要です。
              </p>

              <p style={{ margin: "12px 0 0" }}>
                宿泊と日帰りをどう分けるか、旅費規程にどう定めているか、実際も規程どおり運用しているかによって、税務上の見え方は変わります。
              </p>

              <div
                style={{
                  marginTop: 16,
                  padding: "14px 14px 15px",
                  border: "1px solid #E6EAF2",
                  borderRadius: 12,
                  background: "rgba(248,246,240,0.72)",
                }}
              >
                <p style={{ margin: 0, fontWeight: 900, color: "#0B1220" }}>
                  🔒 ここからは、自社条件で具体的に整理
                </p>

                <ul style={{ margin: "10px 0 0 20px", padding: 0 }}>
                  <li>社長2万円／従業員○円の役職差</li>
                  <li>宿泊／日帰りの線引き</li>
                  <li>近距離出張をどう扱うか</li>
                  <li>税務調査で説明しやすい旅費規程の組み方</li>
                </ul>

                <p style={{ margin: "12px 0 0", fontWeight: 800, color: "#0B1220" }}>
                  御社なら2万円をどう設計するかまで、本サービスで具体的に整理できます。
                </p>
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              <button style={styles.btnPrimary} onClick={onClickExampleTry}>
                自社の場合を相談してみる
              </button>
            </div>
          </article>

          <article style={styles.exampleCard} aria-labelledby="example-entertainment-expense">
            <p style={styles.exampleLabel}>相談例・回答例</p>
            <h3 id="example-entertainment-expense" style={styles.exampleQuestion}>
              取引先との高級クラブで、一晩20万円使いました。交際費にして大丈夫ですか？
            </h3>

            <div style={styles.exampleAnswer}>
              <p style={{ margin: 0 }}>
                <strong>20万円だからという理由だけで、直ちに経費にできないわけではありません。</strong>
                <br />
                大切なのは、誰と行ったか、何の目的だったか、その支出が会社の事業とどう関係するかを説明できることです。
              </p>

              <p style={{ margin: "12px 0 0" }}>
                取引先との関係づくりとして必要な飲食なのか、社長個人の飲食を会社負担にしたものなのか。その線引きは、金額だけでなく利用実態から判断されます。
              </p>

              <div
                style={{
                  marginTop: 16,
                  padding: "14px 14px 15px",
                  border: "1px solid #E6EAF2",
                  borderRadius: 12,
                  background: "rgba(248,246,240,0.72)",
                }}
              >
                <p style={{ margin: 0, fontWeight: 900, color: "#0B1220" }}>
                  🔒 ここからは、自社条件で具体的に整理
                </p>

                <ul style={{ margin: "10px 0 0 20px", padding: 0 }}>
                  <li>20万円、30万円と高額になった場合の考え方</li>
                  <li>同じクラブへ毎月行っている場合の見え方</li>
                  <li>領収書以外に何を残しておくと説明しやすいか</li>
                  <li>二次会・三次会まで会社負担にした場合</li>
                  <li>税務調査で聞かれたときの論点</li>
                </ul>

                <p style={{ margin: "12px 0 0", fontWeight: 800, color: "#0B1220" }}>
                  「一般論として経費になるか」ではなく、御社の使い方ならどこまで現実的かを整理します。
                </p>
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              <button style={styles.btnPrimary} onClick={onClickExampleTry}>
                自社の場合を相談してみる
              </button>
            </div>
          </article>

          {demoAnsweredThisSession && (
            <div style={styles.upgradeCard}>
              <p style={{ margin: 0, color: "rgba(11,18,32,0.78)", lineHeight: 1.7 }}>
                無料体験では、考え方の入口まで整理しました。
                <br />
                有料版では、この相談を次の段階まで具体化できます。
              </p>

              <ul style={{ margin: "14px 0 0 20px", padding: 0, color: "rgba(11,18,32,0.88)", lineHeight: 1.8 }}>
                <li>あなたの会社の金額・運用条件に沿った線引き</li>
                <li>税務上認められやすくするための必要書類</li>
                <li>税務調査で聞かれそうな点と、その説明方法</li>
                <li>顧問税理士へ確認するときの質問文</li>
              </ul>

              <p style={{ ...styles.upgradeTitle, marginTop: 14 }}>
                この相談を、そのまま続けますか？
              </p>

              <div style={{ marginTop: 12 }}>
                <button style={styles.btnPrimary} onClick={onClickShowPlans}>
                  この相談の続きを整理する
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Pre-plan message */}
        <section style={styles.prePlanMessage}>
          <h3 style={styles.prePlanTitle}>可能性を、言葉ひとつで閉じない。</h3>
          <p style={styles.prePlanSub}>“ダメです”で諦めないための整理を。</p>
        </section>

        {/* Plans */}
        <section
          ref={(el) => {
            plansRef.current = el;
          }}
          style={styles.section}
        >
          <details
            open={plansOpen}
            style={{
              ...styles.details,
              outline: demoDone ? "2px solid rgba(30,94,255,0.22)" : "none",
            }}
            onToggle={(e) => setPlansOpen((e.target as HTMLDetailsElement).open)}
          >
            <summary style={styles.summary}>
  <span>プラン</span>
  <span
    style={{
      fontSize: 12,
      color: demoDone
        ? "rgba(30,94,255,0.75)"   // 送信済み時だけ少し青寄り
        : "rgba(11,18,32,0.60)",
      fontWeight: demoDone ? 700 : 400,
      letterSpacing: "0.02em",
    }}
  >
    プランを見る
  </span>
</summary>

            <div style={styles.plansBody}>
              <div style={styles.agreeRow}>
                <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={agreed}
                    onChange={(e) => setAgreed(e.target.checked)}
                    style={{ width: 18, height: 18 }}
                  />
                  <span style={{ color: "rgba(11,18,32,0.86)" }}>利用規約に同意する</span>
                </label>
              </div>

              <div style={styles.planGrid}>
                {PLANS.map((p) => {
                  const disabled = !supabase || busyPlan !== null || !agreed;
                  return (
                    <button
                      key={p.key}
                      onClick={() => goCheckout(p.key)}
                      disabled={disabled}
                      style={{
                        ...styles.planBtn,
                        opacity: disabled ? 0.6 : 1,
                        cursor: disabled ? "not-allowed" : "pointer",
                        background:
                          p.key === "standard"
                            ? "linear-gradient(180deg, rgba(30,94,255,0.10), rgba(30,94,255,0.04))"
                            : "#fff",
                        border:
                          p.key === "standard" ? "1px solid rgba(30,94,255,0.22)" : "1px solid #E6EAF2",
                      }}
                    >
                      <div style={styles.planTop}>
                        <div>
                          <div style={{ fontSize: 18, fontWeight: 950 }}>
                            {p.title}{" "}
                            {p.key === "standard" && <span style={{ ...styles.badge, marginLeft: 8 }}>おすすめ</span>}
                          </div>
                          <div style={{ color: "rgba(11,18,32,0.78)", fontSize: 13, marginTop: 2 }}>
                            {p.quotaLabel} {p.note ? `・${p.note}` : ""}
                          </div>
                        </div>
                        <div style={{ fontSize: 14, color: "rgba(11,18,32,0.92)", fontWeight: 900, whiteSpace: "nowrap", flexShrink: 0 }}>
                          {p.priceLabel}
                        </div>
                      </div>

                      {busyPlan === p.key && (
                        <div style={{ marginTop: 10, color: "rgba(11,18,32,0.75)" }}>決済ページを開いています…</div>
                      )}
                    </button>
                  );
                })}
              </div>              
            </div>
          </details>
        </section>

        {/* Footer */}
        <footer style={styles.footer}>
          <div style={styles.footerTitle}>税理士法人GLADZ</div>
          <div>大阪府大阪市北区梅田1-3-1</div>
          <div>大阪駅前第１ビル10階</div>
          <div>代表税理士　野口　集平</div>
        </footer>

        <style jsx>{`
  section {
    scroll-margin-top: 78px;
  }

  .introGrid {
    display: grid;
    grid-template-columns: minmax(0, 0.92fr) minmax(420px, 1.08fr);
    gap: 52px;
    align-items: start;
    padding: 18px 0 14px;
  }

  .introGrid #demo {
    margin-top: 24px !important;
  }

  #hero .heroCopy {
    order: 1;
  }

  #hero .heroImgFullBleed {
    order: 2;
    margin-top: 30px;
  }

  #hero .heroCapFullBleed {
    order: 3;
  }

  .eyebrow {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 0 0 22px;
    color: #9A7027;
    font-size: 14px;
    font-weight: 800;
    letter-spacing: 0.12em;
  }

  .eyebrow::before,
  .eyebrow::after {
    content: "";
    width: 34px;
    height: 1px;
    background: #B58A3A;
  }

  .contentSection {
    max-width: 920px;
    margin: 34px auto 0;
  }

  @media (max-width: 860px) {
    .introGrid {
      grid-template-columns: 1fr;
      gap: 6px;
      padding-top: 0;
    }

    .introGrid #demo {
      margin-top: 14px !important;
    }

    #hero {
      padding-top: 28px !important;
    }

    #hero .heroTitle {
      font-size: 34px !important;
      line-height: 1.35 !important;
    }

    #hero .heroImgFullBleed {
      min-height: 220px !important;
      margin-top: 24px;
    }

    #hero .heroCapFullBleed {
      padding: 0 8px;
    }

    .eyebrow {
      margin-bottom: 16px;
      font-size: 12px;
    }

    .desktopBreak {
      display: none;
    }
  }

  @media (max-width: 560px) {
    .introGrid {
      margin-left: -8px;
      margin-right: -8px;
    }

    #hero .heroTitle {
      font-size: 30px !important;
    }
  }
`}</style>
      </div>
    </main>
  );
}
