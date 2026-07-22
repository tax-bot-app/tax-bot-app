# さじかげん｜運用RUNBOOK

## OpenAIモデル設定

Vercel Productionに次を設定し、変更後はRedeployする。

- `OPENAI_MODEL`: 回答本文の通常モデル
- `OPENAI_MODEL_TOPIC`: 話題分類の通常モデル
- `OPENAI_MODEL_SMALL`: QA選抜等の通常モデル
- `OPENAI_MODEL_FALLBACKS`: 共通の予備モデル。カンマ区切り、左から優先
- `OPENAI_MODEL_MAIN_FALLBACKS`: 本文専用の予備モデル（任意）
- `OPENAI_MODEL_TOPIC_FALLBACKS`: 分類専用の予備モデル（任意）
- `OPENAI_MODEL_SMALL_FALLBACKS`: 補助処理専用の予備モデル（任意）

秘密鍵の値は資料やGitHubへ貼らない。

## 推奨初期設定

既存の通常モデルは急に置き換えず、まず次を追加する。

```text
OPENAI_MODEL_FALLBACKS=gpt-5.6-sol
```

コード内にも同じ緊急候補があるため、ENV設定漏れでも現在の既定モデル終了時に再試行する。

## 切替確認

Vercel Runtime Logsで次を検索する。

```text
[openai-model-fallback]
```

- `model unavailable; retrying`: 通常モデルが利用不能で次候補へ移行した。
- `switched model`: 予備モデルで処理が成功した。
- `emergency model selected`: 明示候補が全滅し、利用可能モデル一覧から一般向けGPTを自動選択した。直ちにそのモデルをENVへ明示する。
- ログ検知後は、成功したモデルを通常モデルのENVへ昇格してRedeployする。

## リリース確認

1. `npx tsc --noEmit`
2. `npm run build`
3. 無料体験を3回実行し、残回数が正しく減ることを確認
4. 4回目が回答生成されず、プラン案内になることを確認
5. ログイン後チャットを1回実行
6. Vercelログに予期しないフォールバックやAPIエラーがないことを確認

## 定期運用

- 月1回およびOpenAIから提供終了メールを受けた時に、公式Deprecationsページを確認する。
- 現行または予備モデルが終了対象なら、推奨後継を予備ENVの先頭へ追加する。
- 通常モデルの終了前に後継へ昇格する。忘れても実行時フォールバックで回答継続を優先する。
- 通常・予備の全候補が終了しても、一般向けGPTの自動探索を最後に実行する。ただし命名規則自体が変わった場合は自動探索できないため、公式告知の確認は継続する。
