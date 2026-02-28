"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseClient } from "../lib/supabaseClient";

type Phase = "checking" | "ready" | "updating" | "done" | "error";

function normalizeAuthMessage(raw: string): string {
  const m = String(raw ?? "").trim();
  const low = m.toLowerCase();

  if (!m) return "エラーが発生しました。時間をおいてもう一度お試しください。";
  if (low.includes("password should be at least") || low.includes("password") && low.includes("length"))
    return "パスワードが短すぎます。8文字以上で設定してください。";
  if (low.includes("session") && low.includes("missing"))
    return "リンクが無効か、期限切れの可能性があります。再設定メールをもう一度お送りください。";
  if (low.includes("expired"))
    return "リンクの有効期限が切れている可能性があります。再設定メールをもう一度お送りください。";

  // それ以外は断定せず丸める
  return "更新に失敗しました。時間をおいてもう一度お試しください。";
}

export default function ResetPasswordPage() {
  const router = useRouter();
  const supabase = useMemo(() => getSupabaseClient(), []);

  const [phase, setPhase] = useState<Phase>("checking");
  const [message, setMessage] = useState<string>("");
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");

  useEffect(() => {
    let alive = true;

    (async () => {
      // パスワード再設定リンクから来た場合、セッションが張られるまで少しラグることがある
      const tryGet = async () => {
        const { data, error } = await supabase.auth.getSession();
        if (!alive) return { ok: false as const, error };
        if (error) return { ok: false as const, error };
        if (data.session) return { ok: true as const };
        return { ok: false as const, error: null };
      };

      const r1 = await tryGet();
      if (r1.ok) {
        setPhase("ready");
        return;
      }
      if (r1.error) {
        setPhase("error");
        setMessage(normalizeAuthMessage(r1.error.message));
        return;
      }

      // 保険リトライ（600ms）
      setTimeout(async () => {
        if (!alive) return;
        const r2 = await tryGet();
        if (r2.ok) {
          setPhase("ready");
        } else {
          setPhase("error");
          setMessage(
            "再設定用のセッションを確認できませんでした。再設定メールをもう一度お送りください。"
          );
        }
      }, 600);
    })();

    return () => {
      alive = false;
    };
  }, [supabase]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage("");

    if (pw1.length < 8) {
      setMessage("パスワードは8文字以上で設定してください。");
      return;
    }
    if (pw1 !== pw2) {
      setMessage("確認用パスワードが一致していません。");
      return;
    }

    setPhase("updating");

    const { error } = await supabase.auth.updateUser({ password: pw1 });
    if (error) {
      setPhase("error");
      setMessage(normalizeAuthMessage(error.message));
      return;
    }

    // セキュリティ：更新後は一度サインアウトして、通常ログインに戻す
    await supabase.auth.signOut();

    setPhase("done");
    setMessage("パスワードを更新しました。ログイン画面に戻ります。");

    setTimeout(() => {
      router.replace("/login");
    }, 900);
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center bg-zinc-50 px-6">
      <h1 className="text-3xl font-bold mb-6">パスワード再設定</h1>

      <div className="w-full max-w-sm bg-white rounded-xl p-6 shadow">
        {phase === "checking" && (
          <p className="text-sm text-zinc-700">確認中です…</p>
        )}

        {(phase === "ready" || phase === "updating") && (
          <>
            <p className="text-sm text-zinc-700 mb-4">
              新しいパスワードを設定してください（8文字以上）。
            </p>

            <form onSubmit={onSubmit} className="grid gap-3">
              <div>
                <label className="block text-sm mb-1">
                  新しいパスワード <span className="text-xs text-zinc-500">(8文字以上)</span>
                </label>
                <input
                  type="password"
                  className="w-full border rounded-md px-3 py-2"
                  placeholder="新しいパスワード"
                  value={pw1}
                  onChange={(e) => setPw1(e.target.value)}
                  autoComplete="new-password"
                  disabled={phase === "updating"}
                />
              </div>

              <div>
                <label className="block text-sm mb-1">新しいパスワード（確認）</label>
                <input
                  type="password"
                  className="w-full border rounded-md px-3 py-2"
                  placeholder="確認用パスワード"
                  value={pw2}
                  onChange={(e) => setPw2(e.target.value)}
                  autoComplete="new-password"
                  disabled={phase === "updating"}
                />
              </div>

              {message && (
                <p className="text-sm text-red-600">{message}</p>
              )}

              <button
                type="submit"
                disabled={phase === "updating"}
                className="w-full bg-black text-white px-4 py-2 rounded-md disabled:opacity-60"
              >
                {phase === "updating" ? "更新中…" : "更新する"}
              </button>
            </form>

            <p className="text-xs text-zinc-500 mt-4 leading-relaxed">
              ※ この画面は再設定メールのリンクから開いてください。うまく進まない場合は、再設定メールをもう一度お送りください。
            </p>
          </>
        )}

        {phase === "done" && (
          <p className="text-sm text-zinc-700">{message}</p>
        )}

        {phase === "error" && (
          <>
            <p className="text-sm text-red-600">{message}</p>
            <div className="mt-4 grid gap-2">
              <button
                onClick={() => router.replace("/login")}
                className="w-full bg-black text-white px-4 py-2 rounded-md"
              >
                ログイン画面へ
              </button>
              <button
                onClick={() => router.replace("/login")}
                className="w-full bg-white text-black px-4 py-2 rounded-md border"
              >
                再設定メールを送る
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}