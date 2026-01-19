"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseClient } from "../lib/supabaseClient";

type Phase = "checking" | "ready" | "updating" | "done" | "error";

export default function ResetPasswordPage() {
  const router = useRouter();
  const supabase = useMemo(() => getSupabaseClient(), []);

  const [phase, setPhase] = useState<Phase>("checking");
  const [message, setMessage] = useState<string>("");
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.auth.getSession();
      if (error) {
        setPhase("error");
        setMessage(error.message);
        return;
      }

      if (data.session) {
        setPhase("ready");
        return;
      }

      setTimeout(async () => {
        const { data: retry } = await supabase.auth.getSession();
        if (retry.session) {
          setPhase("ready");
        } else {
          setPhase("error");
          setMessage(
            "セッションが取得できませんでした。再設定メールをもう一度送り直してください。"
          );
        }
      }, 600);
    })();
  }, [supabase]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (pw1.length < 8) {
      setMessage("パスワードは8文字以上にして。");
      return;
    }
    if (pw1 !== pw2) {
      setMessage("確認用パスワードが一致してへん。");
      return;
    }

    setPhase("updating");

    const { error } = await supabase.auth.updateUser({ password: pw1 });
    if (error) {
      setPhase("error");
      setMessage(error.message);
      return;
    }

    await supabase.auth.signOut();

    setPhase("done");
    setMessage("更新完了しました。ログイン画面に戻ります。");

    setTimeout(() => {
      router.replace("/login");
    }, 800);
  }

  return (
    <div style={{ maxWidth: 520, margin: "40px auto", padding: 16 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 12 }}>
        パスワード再設定
      </h1>

      {phase === "checking" && <p>セッション確認中…</p>}

      {(phase === "ready" || phase === "updating") && (
        <form onSubmit={onSubmit}>
          <div style={{ display: "grid", gap: 10 }}>
            <input
              type="password"
              placeholder="新しいパスワード"
              value={pw1}
              onChange={(e) => setPw1(e.target.value)}
            />
            <input
              type="password"
              placeholder="新しいパスワード（確認）"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
            />
            <button type="submit">
              {phase === "updating" ? "更新中…" : "更新"}
            </button>
          </div>
        </form>
      )}

      {phase === "done" && <p>{message}</p>}
      {phase === "error" && <p style={{ color: "crimson" }}>{message}</p>}
    </div>
  );
}
