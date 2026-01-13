"use client";

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export default function Home() {
  const goCheckout = async () => {
    try {
      // ① ログインセッション取得（ここで access_token を取る）
      const {
        data: { session },
        error: sessionErr,
      } = await supabase.auth.getSession();

      if (sessionErr || !session?.access_token) {
        alert("ログインしてください（セッションが取得できません）");
        return;
      }

      const accessToken = session.access_token;

      // ② Bearer 付きで create-checkout を叩く
      const res = await fetch("/api/create-checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const data = await res.json();

      if (!res.ok) {
        console.error("create-checkout error:", data);
        alert("決済URLの取得に失敗しました");
        return;
      }

      if (data?.url) {
        window.location.href = data.url;
      } else {
        alert("決済URLが返ってきませんでした");
      }
    } catch (e) {
      console.error(e);
      alert("予期せぬエラーが発生しました");
    }
  };

  return (
    <main className="min-h-screen flex flex-col items-center justify-center bg-zinc-50 px-6">
      <h1 className="text-4xl font-bold mb-4">税務相談AI（テスト版）</h1>

      <p className="text-lg text-zinc-600 mb-8 text-center max-w-md">
        チャットで税務の疑問をすぐ解決。<br />
        月額制で何度でも相談できます。
      </p>

      <button
        onClick={goCheckout}
        className="bg-black text-white px-6 py-3 rounded-lg"
      >
        今すぐ申し込む
      </button>
    </main>
  );
}
