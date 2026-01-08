"use client";
export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center bg-zinc-50 px-6">
      <h1 className="text-4xl font-bold mb-4">
        税務相談AI（テスト版）
      </h1>

      <p className="text-lg text-zinc-600 mb-8 text-center max-w-md">
        チャットで税務の疑問をすぐ解決。<br />
        月額制で何度でも相談できます。
      </p>

      <button
  onClick={async () => {
    const res = await fetch("/api/create-checkout", {
      method: "POST",
    });
    const data = await res.json();
    if (data.url) {
      window.location.href = data.url;
    } else {
      alert("決済URLの取得に失敗しました");
    }
  }}
  className="bg-black text-white px-6 py-3 rounded-lg"
>
  今すぐ申し込む
</button>
    </main>
  );
}
