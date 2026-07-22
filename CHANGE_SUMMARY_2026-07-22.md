# OpenAIモデル提供終了対策｜変更概要

## 変更したもの

- OpenAI Responses APIの5つの呼び出しを共通フォールバック処理へ接続
- 通常モデルが提供終了・不存在・アクセス不可の場合のみ、次候補で再試行
- モデル候補をVercel ENVのカンマ区切りで追加可能に変更
- ENV未設定時も `gpt-5.6-sol` を緊急候補として保持
- 全明示候補が終了した時だけ、利用可能な一般向けGPTを自動探索して疎通確認
- 切替時に機密情報を含まないVercelログを出力
- 確定仕様、RUNBOOK、決定ログ、AGENTS.md、ENV例を追加

## Vercelで追加する値

```text
OPENAI_MODEL_FALLBACKS=gpt-5.6-sol
```

既存の通常モデル設定は、このリリース時点では変更不要。

## 検証結果

- `npx tsc --noEmit`: 成功
- `npm run lint`: 既存コードの181エラーで失敗（今回の新規共通処理にはエラーなし）
- `npm run build`: Google Fonts取得不可で失敗。型・アプリコードのエラーではない

## 本番確認

1. GitHubへ変更を反映してVercelへデプロイ
2. Vercel Productionへ `OPENAI_MODEL_FALLBACKS` を追加してRedeploy
3. 無料体験とログイン後チャットを各1回実行
4. Runtime Logsで `[openai-model-fallback]` とOpenAI APIエラーを確認
