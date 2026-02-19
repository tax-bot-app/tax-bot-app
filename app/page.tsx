"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { getSupabaseClient } from "./lib/supabaseClient";

type Plan = "lite" | "standard" | "enterprise";

const PLANS: Array<{
  key: Plan;
  title: string;
  priceLabel: string;
  quotaLabel: string;
  note?: string;
}> = [
  { key: "lite", title: "Lite", priceLabel: "3,300円/月", quotaLabel: "月5回まで", note: "まず整理だけしたい方向け" },
  { key: "standard", title: "Standard", priceLabel: "16,500円/月", quotaLabel: "月30回まで", note: "一番おすすめ" },
  { key: "enterprise", title: "Enterprise", priceLabel: "33,000円/月", quotaLabel: "月100回まで", note: "複数担当・運用前提" },
];

type CheckoutRes = { ok: true; url: string } | { ok: false; error: string };

type DemoRes = { ok: true; answer: string } | { ok: false; error: string };

const DEMO_COOKIE_KEY = "sajikagen_demo_done";
const DEMO_MAX_LEN = 400;

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

export default function Home() {
  const demoRef = useRef<HTMLElement | null>(null);
  const plansRef = useRef<HTMLElement | null>(null);

  const [fatal, setFatal] = useState<string | null>(null);

  // menu
  const [menuOpen, setMenuOpen] = useState(false);

  // demo
  const [demoInput, setDemoInput] = useState("");
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoDone, setDemoDone] = useState(false);
  const [demoAnswer, setDemoAnswer] = useState<string | null>(null);
  const [demoError, setDemoError] = useState<string | null>(null);

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
    const done = getCookie(DEMO_COOKIE_KEY) === "1";
    if (done) {
      setDemoDone(true);
      setPlansOpen(true);
    }
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

  const scrollTo = (el: HTMLElement | null) => {
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const onClickFreeTry = () => scrollTo(demoRef.current);

  const onClickShowPlans = () => {
    setPlansOpen(true);
    setTimeout(() => scrollTo(plansRef.current), 50);
  };

  const submitDemo = async () => {
    setDemoError(null);
    if (demoDone) return;

    const q = (demoInput ?? "").trim();
    if (!q) {
      setDemoError("相談内容を1行でいいので入れてください。空欄は税務署より厳しい。");
      return;
    }
    if (q.length > DEMO_MAX_LEN) {
      setDemoError(`デモは ${DEMO_MAX_LEN} 文字までにしてます（本番はもっといける）。`);
      return;
    }

    setDemoBusy(true);
    try {
      const res = await fetch("/api/demo-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: q, demo: true }),
      });

      const json = (await res.json().catch(() => null)) as DemoRes | null;
      if (!json) throw new Error("demo-chat: empty response");
      if (!json.ok) throw new Error(json.error || "demo-chat failed");

      setDemoAnswer(json.answer);
      setDemoDone(true);
      setCookie(DEMO_COOKIE_KEY, "1", 365);

      setPlansOpen(true);
      setTimeout(() => scrollTo(plansRef.current), 80);
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
        window.location.href = "/login";
        return;
      }

      const res = await fetch("/api/create-checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${data.session.access_token}`,
        },
        body: JSON.stringify({ plan }),
      });

      const json = (await res.json().catch(() => null)) as CheckoutRes | null;
      if (!json) throw new Error("create-checkout: empty response");
      if (!json.ok) throw new Error(json.error || "create-checkout failed");
      if (!json.url) throw new Error("create-checkout: url missing");

      window.location.href = json.url;
    } catch (e: any) {
      alert(`決済に進めません：${e?.message ?? String(e)}`);
    } finally {
      setBusyPlan(null);
    }
  };

  const styles: Record<string, React.CSSProperties> = {
    wrap: { minHeight: "100vh", background: "#0b0b0c", color: "#fff" },
    container: { maxWidth: 980, margin: "0 auto", padding: "22px 16px 70px" },

    header: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      padding: "10px 0 18px",
      position: "sticky",
      top: 0,
      background: "rgba(11,11,12,0.85)",
      backdropFilter: "blur(10px)",
      zIndex: 10,
      borderBottom: "1px solid rgba(255,255,255,0.08)",
    },
    brand: { display: "flex", alignItems: "center", gap: 10, textDecoration: "none", color: "#fff" },
    brandLogo: { height: 26, width: "auto", display: "block" },

    nav: { display: "flex", alignItems: "center", gap: 10, position: "relative" },
    btnGhost: {
      border: "1px solid rgba(255,255,255,0.16)",
      background: "transparent",
      color: "#fff",
      borderRadius: 12,
      padding: "10px 12px",
      cursor: "pointer",
      fontWeight: 800,
      lineHeight: 1,
    },
    btnPrimary: {
      border: "1px solid rgba(255,255,255,0.12)",
      background: "#fff",
      color: "#111",
      borderRadius: 14,
      padding: "12px 14px",
      cursor: "pointer",
      fontWeight: 900,
      lineHeight: 1,
    },
    menu: {
      position: "absolute",
      top: 46,
      right: 0,
      background: "rgba(14,14,15,0.98)",
      border: "1px solid rgba(255,255,255,0.14)",
      borderRadius: 14,
      padding: 10,
      display: "grid",
      gap: 6,
      minWidth: 170,
      zIndex: 30,
      boxShadow: "0 18px 40px rgba(0,0,0,0.55)",
    },
    menuItem: {
      padding: "10px 10px",
      borderRadius: 10,
      textDecoration: "none",
      color: "rgba(255,255,255,0.92)",
      border: "1px solid rgba(255,255,255,0.00)",
      fontWeight: 800,
      fontSize: 13,
    },

    hero: {
      display: "grid",
      gridTemplateColumns: "1.1fr 0.9fr",
      gap: 18,
      alignItems: "stretch",
      padding: "22px 0 10px",
    },
    heroCard: {
      border: "1px solid rgba(255,255,255,0.10)",
      borderRadius: 18,
      padding: 18,
      background: "linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.03))",
      boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
      display: "flex",
      flexDirection: "column",
      justifyContent: "center",
    },
    h1: { fontSize: 34, lineHeight: 1.15, margin: 0, letterSpacing: "-0.02em" },
    sub: { color: "rgba(255,255,255,0.72)", marginTop: 10, marginBottom: 0, lineHeight: 1.7 },
    heroActions: { display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" },

    heroImgBox: {
      border: "1px solid rgba(255,255,255,0.10)",
      borderRadius: 18,
      overflow: "hidden",
      background: "rgba(255,255,255,0.03)",
      minHeight: 280,
    },
    heroImg: { width: "100%", height: "100%", objectFit: "cover", display: "block" },

    section: { marginTop: 22 },
    sectionTitle: { fontSize: 18, margin: "0 0 10px", letterSpacing: "0.02em" },

    authority: {
      marginTop: 14,
      borderRadius: 18,
      border: "1px solid rgba(255,255,255,0.10)",
      background: "rgba(255,255,255,0.03)",
      padding: 14,
    },
    authorityTitle: { fontWeight: 950, fontSize: 14, margin: 0 },
    authoritySub: { color: "rgba(255,255,255,0.72)", marginTop: 6, marginBottom: 0, lineHeight: 1.7, fontSize: 13 },

    chatShell: {
      borderRadius: 18,
      border: "1px solid rgba(255,255,255,0.10)",
      background: "rgba(0,0,0,0.20)",
      overflow: "hidden",
    },
    chatTop: {
      padding: "12px 14px",
      borderBottom: "1px solid rgba(255,255,255,0.08)",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
    },
    chatTopLeft: { display: "flex", alignItems: "center", gap: 10 },
    dot: { width: 9, height: 9, borderRadius: 99, background: "rgba(255,255,255,0.55)" },
    chatBody: { padding: 14, display: "grid", gap: 10 },
    bubbleBot: {
      justifySelf: "start",
      maxWidth: "90%",
      padding: "10px 12px",
      borderRadius: 16,
      background: "rgba(255,255,255,0.06)",
      border: "1px solid rgba(255,255,255,0.10)",
      whiteSpace: "pre-wrap",
      lineHeight: 1.7,
      color: "rgba(255,255,255,0.92)",
    },
    bubbleUser: {
      justifySelf: "end",
      maxWidth: "85%",
      padding: "10px 12px",
      borderRadius: 16,
      background: "rgba(255,255,255,0.12)",
      border: "1px solid rgba(255,255,255,0.10)",
      whiteSpace: "pre-wrap",
      lineHeight: 1.6,
    },
    inputRow: {
      padding: 12,
      borderTop: "1px solid rgba(255,255,255,0.08)",
      display: "grid",
      gridTemplateColumns: "1fr auto",
      gap: 10,
      alignItems: "center",
      background: "rgba(0,0,0,0.18)",
    },
    textarea: {
      width: "100%",
      minHeight: 44,
      maxHeight: 120,
      resize: "vertical",
      padding: "10px 12px",
      borderRadius: 14,
      border: "1px solid rgba(255,255,255,0.14)",
      outline: "none",
      background: "rgba(255,255,255,0.06)",
      color: "#fff",
      lineHeight: 1.6,
    },
    small: { color: "rgba(255,255,255,0.62)", fontSize: 12, lineHeight: 1.6, marginTop: 10 },
    warn: {
      marginTop: 10,
      padding: 10,
      borderRadius: 14,
      background: "rgba(255,100,100,0.12)",
      border: "1px solid rgba(255,100,100,0.30)",
      color: "rgba(255,220,220,0.95)",
      whiteSpace: "pre-wrap",
    },

    prePlanMessage: {
      marginTop: 26,
      textAlign: "center",
      borderRadius: 18,
      border: "1px solid rgba(255,255,255,0.10)",
      background: "rgba(255,255,255,0.03)",
      padding: "16px 14px",
    },
    prePlanTitle: { fontSize: 20, fontWeight: 950, margin: 0 },
    prePlanSub: { color: "rgba(255,255,255,0.72)", marginTop: 8, marginBottom: 0, lineHeight: 1.7 },

    details: {
      border: "1px solid rgba(255,255,255,0.10)",
      borderRadius: 18,
      background: "rgba(255,255,255,0.03)",
      overflow: "hidden",
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
    },
    plansBody: { padding: "0 16px 16px" },
    agreeRow: { display: "flex", alignItems: "center", gap: 10, marginTop: 12, marginBottom: 10, flexWrap: "wrap" },

    planGrid: { display: "grid", gap: 10, marginTop: 10 },
    planBtn: {
      textAlign: "left",
      padding: 14,
      borderRadius: 16,
      border: "1px solid rgba(255,255,255,0.12)",
      background: "rgba(255,255,255,0.06)",
      color: "#fff",
      cursor: "pointer",
    },
    planTop: { display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" },
    badge: {
      fontSize: 12,
      padding: "4px 8px",
      borderRadius: 999,
      border: "1px solid rgba(255,255,255,0.18)",
      color: "rgba(255,255,255,0.85)",
    },

    footer: { marginTop: 40, color: "rgba(255,255,255,0.6)", fontSize: 12, lineHeight: 1.7 },
    footerTitle: { fontWeight: 900, color: "rgba(255,255,255,0.82)" },
  };

  return (
    <main style={styles.wrap}>
      <div style={styles.container}>
        {/* Header */}
        <header style={styles.header}>
          <Link href="/" style={styles.brand} aria-label="さじかげん">
            <img src="/sa-logo-header.png" alt="さじかげん" style={styles.brandLogo} />
          </Link>

          <nav style={styles.nav} data-menu-root>
            <Link href="/login" style={{ ...styles.btnGhost, textDecoration: "none", display: "inline-block" }}>
              ログイン
            </Link>
            <button style={styles.btnGhost} onClick={onClickFreeTry} aria-label="無料体験へ">
              無料体験
            </button>

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
                  onMouseEnter={(e) => ((e.currentTarget.style.background = "rgba(255,255,255,0.06)"))}
                  onMouseLeave={(e) => ((e.currentTarget.style.background = "transparent"))}
                >
                  FAQ
                </Link>
                <Link
                  href="/privacy"
                  style={styles.menuItem}
                  onClick={() => setMenuOpen(false)}
                  onMouseEnter={(e) => ((e.currentTarget.style.background = "rgba(255,255,255,0.06)"))}
                  onMouseLeave={(e) => ((e.currentTarget.style.background = "transparent"))}
                >
                  プライバシー
                </Link>
                <Link
                  href="/terms"
                  style={styles.menuItem}
                  onClick={() => setMenuOpen(false)}
                  onMouseEnter={(e) => ((e.currentTarget.style.background = "rgba(255,255,255,0.06)"))}
                  onMouseLeave={(e) => ((e.currentTarget.style.background = "transparent"))}
                >
                  利用規約
                </Link>
              </div>
            )}
          </nav>
        </header>

        {/* Hero */}
        <section style={styles.hero}>
          <div style={styles.heroImgBox}>
            <img src="/ai-noguchi-hero.PNG" alt="AI野口 ヒーロー" style={styles.heroImg} />
          </div>

          <div style={styles.heroCard}>
            <h1 style={styles.h1}>税理士はそのまま。相談だけ、もう一段。</h1>
            <p style={styles.sub}>
              「ダメ」で止めずに、税務調査の現実を踏まえて整理する。
              <br />
              自社に合う可能性を、ちゃんと見極める。
            </p>

            <div style={styles.heroActions}>
              <button style={styles.btnPrimary} onClick={onClickFreeTry}>
                無料で相談してみる
              </button>
              <button style={styles.btnGhost} onClick={onClickShowPlans}>
                プランを確認する
              </button>
            </div>

            <p style={{ ...styles.small, marginTop: 12 }}>
              ※ デモは登録不要・1回だけ（Cookie制限）。数字や深掘りは控えめに出ます。
            </p>

            {fatal && <div style={styles.warn}>{fatal}</div>}
          </div>
        </section>

        {/* Authority block (SPでも強く見せる) */}
        <section style={styles.authority}>
          <p style={styles.authorityTitle}>
            大手ドラッグストアチェーン顧問で豊富な税務調査対応経験のある代表税理士 野口のAI
          </p>
          <p style={styles.authoritySub}>
            机上の理屈だけで終わらせず、現場の“揉めどころ”を踏まえて整理します。
          </p>
        </section>

        {/* Demo */}
        <section
          ref={(el) => {
            demoRef.current = el;
          }}
          id="demo"
          style={styles.section}
        >
          <h2 style={styles.sectionTitle}>無料体験（1問）</h2>

          <div style={styles.chatShell}>
            <div style={styles.chatTop}>
              <div style={styles.chatTopLeft}>
                <div style={styles.dot} />
                <div style={{ fontWeight: 900 }}>さじかげん（デモ）</div>
              </div>
              <div style={{ color: "rgba(255,255,255,0.55)", fontSize: 12 }}>{demoDone ? "送信済み" : "未送信"}</div>
            </div>

            <div style={styles.chatBody}>
              {!demoAnswer && (
                <div style={styles.bubbleBot}>
                  相談内容をフリーワードでどうぞ。
                  <br />
                  例：出張手当／交際費／家族給与／紹介料…あたり。
                </div>
              )}

              {demoInput.trim() && <div style={styles.bubbleUser}>{demoInput.trim()}</div>}
              {demoAnswer && <div style={styles.bubbleBot}>{demoAnswer}</div>}

              {demoError && <div style={styles.warn}>{demoError}</div>}

              <div style={styles.small}>
                出力はデモ用に短めです（要点2・注意1）。本サービスでは金額レンジの具体化や条件分岐まで整理します。
              </div>
            </div>

            {!demoDone && (
              <div style={styles.inputRow}>
                <textarea
                  value={demoInput}
                  onChange={(e) => setDemoInput(e.target.value)}
                  placeholder="相談内容を入力（例：打合せの会食、1人9,000〜11,000円の運用どうする？）"
                  style={styles.textarea}
                  maxLength={DEMO_MAX_LEN + 20}
                  disabled={demoBusy}
                />
                <button
                  style={{
                    ...styles.btnPrimary,
                    opacity: demoBusy ? 0.6 : 1,
                    cursor: demoBusy ? "not-allowed" : "pointer",
                    padding: "12px 14px",
                  }}
                  onClick={submitDemo}
                  disabled={demoBusy}
                >
                  {demoBusy ? "送信中…" : "送信"}
                </button>
              </div>
            )}
          </div>

          {demoDone && (
            <div style={{ ...styles.authority, marginTop: 14 }}>
              <div style={{ fontWeight: 900, marginBottom: 8 }}>※ 本サービスでは</div>
              <ul style={{ margin: "0 0 10px 18px", color: "rgba(255,255,255,0.82)", lineHeight: 1.7 }}>
                <li>金額レンジの具体化</li>
                <li>条件分岐ごとの実務整理</li>
                <li>税務調査目線での想定問答</li>
              </ul>

              <div style={{ color: "rgba(255,255,255,0.82)", lineHeight: 1.7 }}>
                このテーマ、放置すると “なんとなく不安” が残ります。
                <br />
                いま整理しますか？
              </div>

              <div style={{ marginTop: 12 }}>
                <button style={styles.btnPrimary} onClick={onClickShowPlans}>
                  プランを確認する
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Pre-plan message (moved: just above Plans) */}
        <section style={styles.prePlanMessage}>
          <h3 style={styles.prePlanTitle}>可能性を、言葉ひとつで閉じない。</h3>
          <p style={styles.prePlanSub}>“とりあえず守る”で止めないための整理を。</p>
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
              outline: demoDone ? "2px solid rgba(255,255,255,0.22)" : "none",
            }}
            onToggle={(e) => setPlansOpen((e.target as HTMLDetailsElement).open)}
          >
            <summary style={styles.summary}>
              <span>プラン</span>
              <span style={{ color: "rgba(255,255,255,0.6)", fontSize: 12 }}>{demoDone ? "デモ後はここが本番" : "いつでも開けます"}</span>
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
                  <span style={{ color: "rgba(255,255,255,0.86)" }}>利用規約に同意する</span>
                </label>

                <span style={{ ...styles.small, marginTop: 0 }}>※ 未ログインならログインへ → その後Stripe決済</span>
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
                            ? "linear-gradient(180deg, rgba(255,255,255,0.10), rgba(255,255,255,0.05))"
                            : "rgba(255,255,255,0.06)",
                      }}
                    >
                      <div style={styles.planTop}>
                        <div>
                          <div style={{ fontSize: 18, fontWeight: 950 }}>
                            {p.title}{" "}
                            {p.key === "standard" && <span style={{ ...styles.badge, marginLeft: 8 }}>おすすめ</span>}
                          </div>
                          <div style={{ color: "rgba(255,255,255,0.78)", fontSize: 13, marginTop: 2 }}>
                            {p.quotaLabel} {p.note ? `・${p.note}` : ""}
                          </div>
                        </div>
                        <div style={{ fontSize: 14, color: "rgba(255,255,255,0.92)", fontWeight: 900 }}>
                          {p.priceLabel}
                        </div>
                      </div>

                      {busyPlan === p.key && (
                        <div style={{ marginTop: 10, color: "rgba(255,255,255,0.75)" }}>決済ページを開いています…</div>
                      )}
                    </button>
                  );
                })}
              </div>

              <div style={{ ...styles.small, marginTop: 12 }}>
                ※ 申込専用ページは作りません（トップ→チェックアウト直行）。
                <br />
                ※ メンテナンス時は /maintenance と ENV（MAINTENANCE_MODE）で制御予定。
              </div>
            </div>
          </details>
        </section>

        {/* Footer (company profile only) */}
        <footer style={styles.footer}>
          <div style={styles.footerTitle}>税理士法人GLADZ</div>
          <div>大阪府大阪市北区梅田1-3-1</div>
          <div>大阪駅前第１ビル10階</div>
          <div>代表税理士　野口　集平</div>
        </footer>

        {/* Responsive */}
        <style jsx>{`
          section {
            scroll-margin-top: 78px;
          }
          @media (max-width: 860px) {
            /* SP：上から画像 → コピー（heroの左右を縦に） */
            .heroFix {
              display: block;
            }
          }
        `}</style>
      </div>
    </main>
  );
}
