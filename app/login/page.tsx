"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";

type Msg = { kind: "error" | "info"; text: string } | null;

function normalizeEmail(s: string) {
  return String(s ?? "").trim().toLowerCase();
}

function friendlyAuthMessage(raw: string, action: "signin" | "signup" | "reset"): string {
  const m = String(raw ?? "").trim();
  const low = m.toLowerCase();

  // よくあるSupabaseの英語を、日本語に丸める（詳細は出しすぎない）
  if (low.includes("invalid login credentials")) return "メールアドレスかパスワードが違います。";
  if (low.includes("email not confirmed")) return "メールの確認が完了していません。受信箱の確認メールをご確認ください。";
  if (low.includes("user already registered")) return "そのメールアドレスはすでに登録されています。ログインしてください。";
  if (low.includes("signup is disabled")) return "現在、新規登録を受け付けていません。";
  if (low.includes("anonymous sign-ins are disabled")) return "登録に失敗しました。メールアドレスとパスワードをご確認ください。";
  if (low.includes("password should be at least")) return "パスワードが短すぎます。もう少し長くしてください。";
  if (low.includes("email address") && low.includes("invalid")) return "メールアドレスの形式をご確認ください。";
  if (low.includes("rate limit")) return "操作が多すぎます。少し時間をおいてからお試しください。";

  // 422系など、運用設定/ポリシーが絡む場合は “原因を断定しない” 文言で止める
  if (action === "signup") return "新規登録に失敗しました。入力内容をご確認のうえ、もう一度お試しください。";
  if (action === "signin") return "ログインに失敗しました。入力内容をご確認のうえ、もう一度お試しください。";
  return "処理に失敗しました。少し時間をおいてからお試しください。";
}

function LoginInner() {
  const router = useRouter();
  const sp = useSearchParams();

  const supabase = useMemo(() => {
    return createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
  }, []);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const reason = sp.get("reason");
    if (reason === "expired") setMsg({ kind: "info", text: "セッションが切れています。ログインし直してください。" });
  }, [sp]);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      if (data.session) {
        router.replace("/chat");
        router.refresh();
      }
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        router.replace("/chat");
        router.refresh();
      }
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [router, supabase]);

  const signIn = async () => {
    setMsg(null);
    const e = normalizeEmail(email);
    if (!e || !password) {
      setMsg({ kind: "error", text: "メールとパスワードを入力してください。" });
      return;
    }

    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: e, password });
      if (error) {
        setMsg({ kind: "error", text: friendlyAuthMessage(error.message, "signin") });
        return;
      }
      router.replace("/chat");
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const signUp = async () => {
    setMsg(null);
    const e = normalizeEmail(email);
    if (!e || !password) {
      setMsg({ kind: "error", text: "メールとパスワードを入力してください。" });
      return;
    }
    if (password.length < 8) {
      setMsg({ kind: "error", text: "パスワードは8文字以上にしてください。" });
      return;
    }

    setBusy(true);
    try {
      // 確認メールのリンク先（本番/ローカルで正しく動く）
      const emailRedirectTo = `${window.location.origin}/login`;

      const { data, error } = await supabase.auth.signUp({
        email: e,
        password,
        options: { emailRedirectTo },
      });

      if (error) {
        setMsg({ kind: "error", text: friendlyAuthMessage(error.message, "signup") });
        return;
      }

      // 確認メールが不要な設定なら session が返る場合がある
      if (data.session) {
        router.replace("/chat");
        router.refresh();
        return;
      }

      setMsg({ kind: "info", text: "登録を受け付けました。確認メールが届いている場合は、メール内のリンクを開いてからログインしてください。" });
    } finally {
      setBusy(false);
    }
  };

  const sendReset = async () => {
    setMsg(null);
    const e = normalizeEmail(email);
    if (!e) {
      setMsg({ kind: "error", text: "メールアドレスを入力してください。" });
      return;
    }

    setBusy(true);
    try {
      const redirectTo = `${window.location.origin}/reset-password`;
      const { error } = await supabase.auth.resetPasswordForEmail(e, { redirectTo });
      if (error) {
        setMsg({ kind: "error", text: friendlyAuthMessage(error.message, "reset") });
        return;
      }
      setMsg({ kind: "info", text: "再設定メールを送りました。受信箱（迷惑メールも）をご確認ください。" });
    } finally {
      setBusy(false);
    }
  };

 return (
  <main className="min-h-screen flex flex-col items-center justify-center bg-zinc-50 px-6">
    <h1 className="text-3xl font-bold mb-6">さじかげん・ログイン</h1>

    <div className="w-full max-w-sm bg-white rounded-xl p-6 shadow">
      <label className="block text-sm mb-1">メール</label>
      <input
        className="w-full border rounded-md px-3 py-2 mb-4"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        autoComplete="email"
        inputMode="email"
      />

      <label className="block text-sm mb-1">
        パスワード <span className="text-xs text-zinc-500">(8文字以上)</span>
      </label>
      <input
        className="w-full border rounded-md px-3 py-2 mb-4"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        type="password"
        placeholder="入力してください"
        autoComplete="current-password"
      />

      {msg && (
        <p className={`text-sm mb-3 ${msg.kind === "error" ? "text-red-600" : "text-zinc-700"}`}>
          {msg.text}
        </p>
      )}

      <div className="flex gap-2">
        <button
          onClick={signIn}
          disabled={busy}
          className="flex-1 bg-black text-white px-4 py-2 rounded-md disabled:opacity-60"
        >
          ログイン
        </button>
        <button
          onClick={signUp}
          disabled={busy}
          className="flex-1 bg-zinc-200 text-black px-4 py-2 rounded-md disabled:opacity-60"
        >
          新規登録
        </button>
      </div>

      <button
        onClick={sendReset}
        disabled={busy}
        className="w-full mt-3 bg-white text-black px-4 py-2 rounded-md border disabled:opacity-60"
      >
        パスワードを忘れた場合はこちら（再設定メール送信）
      </button>

      {/* ✅ 常に下段に表示 */}
      <div className="mt-4 text-xs text-zinc-600 leading-relaxed border-t pt-3">
        <p className="font-semibold mb-1">新規登録の流れ</p>
        <p>
          メールアドレスとパスワード（8文字以上）を設定し、「新規登録」を押してください。
          認証メールが届きますので、メール内のリンクを開いて認証を完了してください。
        </p>
      </div>
    </div>
  </main>
);
}

<div className="mt-4 text-xs text-zinc-600 leading-relaxed border-t pt-3">
  <p className="font-semibold mb-1">新規登録の流れ</p>
  <p>
    メールアドレスとパスワード（8文字以上）を設定し、「新規登録」を押してください。
    認証メールが届きますので、メール内のリンクを開いて認証を完了してください。
  </p>
</div>

export default function LoginPage() {
  return (
    <Suspense fallback={<div />}>
      <LoginInner />
    </Suspense>
  );
}