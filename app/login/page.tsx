"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@supabase/supabase-js";

export default function LoginPage() {
  const router = useRouter();
  const sp = useSearchParams();

  const supabase = useMemo(() => {
    return createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
  }, []);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // reason 表示（ChatClient→login のときに付ける）
  useEffect(() => {
    const reason = sp.get("reason");
    if (reason === "expired") setMsg("セッション切れてる。ログインし直してな。");
  }, [sp]);

  // 初期判定：ログイン済みなら /chat へ（replaceで履歴に残さない）
  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      if (data.session) router.replace("/chat");
    });

    // ログイン成功を確実に拾う（signIn後に即遷移）
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) router.replace("/chat");
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [router, supabase]);

  const signIn = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setMsg(error.message);
        return;
      }
      router.replace("/chat");
    } finally {
      setBusy(false);
    }
  };

  const signUp = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) {
        setMsg(error.message);
        return;
      }
      setMsg("登録OK。メール確認が必要なら確認してからログインしてな。");
    } finally {
      setBusy(false);
    }
  };

  const sendReset = async () => {
    setMsg(null);
    setBusy(true);
    try {
      if (!email) {
        setMsg("メールアドレス入れてから押して。");
        return;
      }
      const redirectTo = `${window.location.origin}/reset-password`;
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
      if (error) {
        setMsg(error.message);
        return;
      }
      setMsg("再設定メール送った。受信箱（迷惑メールも）見て。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen flex flex-col items-center justify-center bg-zinc-50 px-6">
      <h1 className="text-3xl font-bold mb-6">ログイン</h1>

      <div className="w-full max-w-sm bg-white rounded-xl p-6 shadow">
        <label className="block text-sm mb-1">メール</label>
        <input
          className="w-full border rounded-md px-3 py-2 mb-4"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />

        <label className="block text-sm mb-1">パスワード</label>
        <input
          className="w-full border rounded-md px-3 py-2 mb-4"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          placeholder="********"
        />

        {msg && <p className="text-sm text-red-600 mb-3">{msg}</p>}

        <div className="flex gap-2">
          <button
            onClick={signIn}
            disabled={busy}
            className="flex-1 bg-black text-white px-4 py-2 rounded-md"
          >
            ログイン
          </button>
          <button
            onClick={signUp}
            disabled={busy}
            className="flex-1 bg-zinc-200 text-black px-4 py-2 rounded-md"
          >
            新規登録
          </button>
        </div>

        <button
          onClick={sendReset}
          disabled={busy}
          className="w-full mt-3 bg-white text-black px-4 py-2 rounded-md border"
        >
          パスワードを忘れた（再設定メール送信）
        </button>
      </div>
    </main>
  );
}
