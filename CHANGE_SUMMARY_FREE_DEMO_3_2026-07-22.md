# 無料体験3回化：変更概要

## 変更内容

- 無料体験を1端末1回から3回へ変更
- 画面に使用回数（0 / 3〜3 / 3）を表示
- 3回目まで送信可能、4回目以降は回答を生成せずプランへ案内
- Cookie・localStorageを完了フラグから利用回数へ変更
- 既存の端末DBとUNIQUE制約を変えず、端末ごとに3つの試行枠を使用
- 旧仕様で利用済みの1回は引き継ぎ、残り2回として扱う
- FAQ、確定仕様、RUNBOOK、決定ログを更新

## GitHubへコピーするファイル

```text
app/page.tsx
app/api/demo-chat/route.ts
app/lib/faqItems.ts
docs/00_憲法_確定仕様.md
docs/01_運用_RUNBOOK.md
docs/04_決定ログ.md
CHANGE_SUMMARY_FREE_DEMO_3_2026-07-22.md
```

## 検証結果

- `npx tsc --noEmit`：成功
- `npm run build`：Google Fontsへの接続制限で停止。今回の変更箇所のコンパイルエラーはなし

## 本番確認

1. 新しいブラウザまたはCookie・localStorageを消した状態でトップを開く
2. 表示が `0 / 3回使用` であることを確認
3. 3回送信し、表示が `1 / 3` → `2 / 3` → `3 / 3` になることを確認
4. 3回目の後、入力欄と送信ボタンが無効になり、`3回使用済み` と表示されることを確認
5. 再読み込み後も `3 / 3回使用` が維持されることを確認
6. Vercel Runtime Logsに予期しないAPIエラーがないことを確認
