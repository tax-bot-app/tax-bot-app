"use client";

import { useEffect, useState } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) window.location.href = "/";
    });
  }, []);

  const signIn = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) {
        setMsg(error.message);
        return;
      }
      window.location.href = "/";
    } finally {
      setBusy(false);
    }
  };

  const signUp = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const { error } = await supabase.auth.signUp({
        email,
        password,
      });
      if (error) {
        setMsg(error.message);
        return;
      }
      setMsg("登録OK。メール確認が必要なら確認してからログインしてください。");
    } finally {
      setBusy(false);
    }
  };

  // ★追加：パスワード再設定メール送信（redirectTo を必ず reset-password にする）
  const sendReset = async () => {
    setMsg(null);
    setBusy(true);
    try {
      if (!email) {
        setMsg("メールアドレスを入力してから押して。");
        return;
      }

      const redirectTo = `${window.location.origin}/reset-password`;

      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo,
      });

      if (error) {
        setMsg(error.message);
        return;
      }

      setMsg("再設定メールを送信しました。受信箱（迷惑メールも）を確認してください。");
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

        {/* ★追加：再設定メール送信 */}
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
