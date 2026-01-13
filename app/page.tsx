"use client";

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type Plan = "lite" | "standard" | "enterprise";

const PLANS: Array<{
  key: Plan;
  title: string;
  priceLabel: string;
  quotaLabel: string;
}> = [
  { key: "lite", title: "Lite", priceLabel: "3,300円/月", quotaLabel: "月5回まで" },
  {
    key: "standard",
    title: "Standard",
    priceLabel: "16,500円/月",
    quotaLabel: "月20回まで",
  },
  {
    key: "enterprise",
    title: "Enterprise",
    priceLabel: "33,000円/月",
    quotaLabel: "月100回まで",
  },
];

export default function Home() {
  const goCheckout = async (plan: Plan) => {
    try {
      const {
        data: { session },
        error: sessionErr,
      } = await supabase.auth.getSession();

      if (sessionErr || !session?.access_token) {
        window.location.href = "/login";
        return;
      }

      const accessToken = session.access_token;

      const res = await fetch("/api/create-checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ plan }),
      });

      const data = await res.json();

      if (!res.ok) {
        console.error("create-checkout error:", data);
        alert(data?.error ?? "決済URLの取得に失敗しました");
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
      <h1 className="text-4xl font-bold mb-3">税務相談AI（テスト版）</h1>

      <p className="text-lg text-zinc-600 mb-6 text-center max-w-md">
        月額プランで税務相談ができます（回数制限あり）。
        <br />
        プランを選んでお申し込みください。
      </p>

      <div className="w-full max-w-md space-y-3">
        {PLANS.map((p) => (
          <button
            key={p.key}
            onClick={() => goCheckout(p.key)}
            className="w-full bg-black text-white px-6 py-4 rounded-lg text-left"
          >
            <div className="flex items-baseline justify-between">
              <span className="text-lg font-semibold">{p.title}</span>
              <span className="text-base">{p.priceLabel}</span>
            </div>
            <div className="text-sm text-zinc-200 mt-1">{p.quotaLabel}</div>
          </button>
        ))}
      </div>

      <p className="text-sm text-zinc-500 mt-6">
        ※ログインしていない場合はログイン画面に移動します
      </p>
    </main>
  );
}
