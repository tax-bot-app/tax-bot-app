# さじかげん｜運用RUNBOOK

## Proxyとメンテナンス切替

- リクエスト前処理は、ルート直下の `proxy.ts` で行う。
- `middleware.ts` を同時に置かない。
- `MAINTENANCE_MODE` の `off`、`soft`、`hard` の意味と切替手順は変更しない。
- リリース時は `npm run build` に `middleware` 非推奨警告が出ないことを確認する。

### 本番確認

1. `off` でトップ、ログイン、チャットが通常どおり開くことを確認
2. `soft` で未ログイン利用者が `/maintenance` へ移動し、ログイン済み利用者はチャットを開けることを確認
3. `hard` で通常ページが `/maintenance` へ移動することを確認
4. `/maintenance`、`/login`、認証コールバック、`/_next`、静的ファイルでリダイレクトループや表示崩れがないことを確認
5. ログイン状態を更新した時に、Supabaseの認証Cookieが失われないことを確認

## フォントとビルド

- フォントは `@fontsource-variable/geist`、`@fontsource-variable/geist-mono`、`@fontsource/yuji-syuku` から配信する。
- `next/font/google` は使用せず、`npm run build` がGoogle Fontsへの接続なしで完了することを確認する。
- 依存関係を反映するため、フォント変更時は `package.json` と `package-lock.json` を必ず同時に反映する。
- `STRIPE_SECRET_KEY` と `STRIPE_WEBHOOK_SECRET` はビルド時ではなく各APIの実行時に必須とする。本番ENVは従来どおりVercelへ設定する。

## 回数制御の自動テスト

コード変更後は、型チェックとビルドの前に次を実行する。

```text
npm test
```

次の分岐がすべて成功することを確認する。

- 無制限ユーザーは利用数を取得せず回答処理へ進む
- 月間上限未満は回答処理へ進む
- 月間上限到達済みは回答処理へ進まない
- 利用数確認失敗は回答処理へ進まない
- 無料体験の正常回答は予約枠を残す
- 無料体験の空回答、Abort、例外は予約枠を解放する
- Stripeの複数契約では最上位の有効プランを選ぶ
- 旧Price IDを認識する
- 有効契約のPrice IDがすべて未知の場合は `free` にせず未解決として扱う
- 解約済み・延滞中の契約は有効プラン判定から除外する
- Checkout完了時は認証済み `user_id` をメールアドレスより優先する
- `user_id` のない旧Checkoutだけメールアドレスで紐付ける
- 不正な `user_id` や識別情報なしを、別利用者へフォールバックしない
- 管理APIはBearer tokenなしを401で拒否する
- 管理APIは無効なセッションを401で拒否する
- 管理APIは認証済み非管理者を403で拒否する
- 管理APIはメールアドレスではなく認証済み `user_id` と `is_admin` で許可する
- `/api/admin` 配下の全ルートが共通の管理者認証を呼び出す

## 管理APIの認証確認

1. 管理者で利用状況、プラン変更、ユーザー同期、無制限allowlist、知識管理の各画面を操作できることを確認
2. 非管理者のBearer tokenで管理APIを呼び、403になることを確認
3. Bearer tokenなしと期限切れtokenで管理APIを呼び、いずれも401になることを確認
4. 非管理者でchat-debug一覧とCSVを呼び、いずれも403になることを確認
5. 管理者でchat-debug一覧とCSVを取得できることを確認
6. Vercelログにサービス権限の鍵、Bearer token、利用者のメールアドレスが出ていないことを確認

## 有料チャットの回数上限確認

1. 当月残回数が1回のテストユーザーで相談し、回答成功後に残回数が0になることを確認
2. 同じユーザーでもう一度相談し、AI回答が生成されず回数上限の案内になることを確認
3. Vercelログで、2回目の相談についてOpenAI呼び出しが開始されていないことを確認
4. 無制限対象ユーザーでは、通常どおり回答できることを確認

補足：

- この事前確認は、すでに上限へ達している通常リクエストの無駄なAI生成を止めるためのもの。
- 同時に到達した複数リクエストの最終判定は、回答生成後の `consume_talk_v2` が行う。

## Stripe料金設定

Vercel Productionに新料金のPrice IDを設定し、変更後はRedeployする。

- `PRICE_ID_LITE_NEXT`: 月額1,480円（税込）
- `PRICE_ID_STANDARD_NEXT`: 月額4,800円（税込）
- `PRICE_ID_ENTERPRISE_NEXT`: 月額9,800円（税込）
- `NEXT_PUBLIC_SITE_URL`: 認証callback・Checkout・Customer Portalで共用する本番サイトのHTTPS URL。`APP_URL` は戻り先判定に使用しない

旧Price IDは、新料金での本番決済、Webhook同期、利用回数、Customer Portalを確認するまで削除・アーカイブしない。

### 新料金の本番確認

1. トップの表示価格がStripe Checkoutの金額と一致することを3プランすべて確認
2. 各プランでCheckoutを実行し、新しいPrice IDが使われることを確認
3. Webhook成功後、`users.plan`と`monthly_quota`が正しいことを確認
4. Liteは5回、Standardは30回、Enterpriseは100回になっていることを確認
5. Customer Portalで契約内容と金額を確認
6. 管理画面の想定売上が新料金で集計されることを確認
7. 問題がなければStripeの旧価格をアーカイブ

### Checkout戻り先の確認

1. Vercel Productionの `NEXT_PUBLIC_SITE_URL` が本番サイトのHTTPS URLであることを確認
2. Checkoutを完了し、`NEXT_PUBLIC_SITE_URL` の `/success` へ戻ることを確認
3. Checkoutをキャンセルし、`NEXT_PUBLIC_SITE_URL` のトップへ戻ることを確認
4. VercelのプレビューURLからCheckoutを開始した場合も、完了・キャンセル後は本番サイトへ戻ることを確認

### Checkout重複作成防止の確認

1. 同じ未契約ユーザー・同じプランで、Checkout作成APIを短時間に2回実行する
2. 2回とも同じCheckout SessionのURLが返ることを確認する
3. Stripe Dashboardで同じ条件のCheckout Sessionが重複作成されていないことを確認する
4. 別プランまたはPrice ID切替後は、異なる冪等キーで新しいCheckout Sessionを作成できることを確認する
5. 既存の有効契約がある場合は、従来どおり409で新規Checkoutが停止することを確認する

### 認証・Customer Portal戻り先の確認

1. 認証メールのリンクから認証し、`NEXT_PUBLIC_SITE_URL` のプラン選択またはCheckoutへ戻ることを確認
2. Customer Portalを終了し、`NEXT_PUBLIC_SITE_URL` の `/chat` へ戻ることを確認
3. Vercel Runtime Logsに `Invalid NEXT_PUBLIC_SITE_URL` が出ていないことを確認

### Customer Portal利用者紐付けの確認

1. 契約済み利用者で請求設定を開き、既存のStripe CustomerのPortalが表示されることを確認
2. Stripe側または認証側のメールアドレス表記が変わっても、`users.id` が一致する利用者のPortalが開くことを確認
3. 未購入利用者で請求設定を開き、Stripe Customerが新規作成されずトップのプラン選択へ戻ることを確認
4. 別利用者の `stripe_customer_id` が使用されていないことをStripe Dashboardで確認

## セキュリティヘッダ確認

本番デプロイ後、トップページと認証・チャット画面のレスポンスヘッダを確認する。

- `Content-Security-Policy` に `frame-ancestors 'none'` がある
- `X-Frame-Options` が `DENY`
- `X-Content-Type-Options` が `nosniff`
- `Referrer-Policy` が `strict-origin-when-cross-origin`
- `Permissions-Policy` でcamera、microphone、geolocation、paymentが無効
- 本番だけ `Strict-Transport-Security: max-age=31536000` がある

あわせて、Meta Pixel、Supabaseログイン、Stripe Checkout、Customer Portal、無料体験、有料チャットが従来どおり動くことを確認する。

## Stripe Webhookの再実行管理

初回リリース前にSupabase SQL Editorで次を実行する。

```text
docs/sql/20260723_stripe_webhook_event_status.sql
```

コードを先にデプロイすると新しい列が存在せずWebhookが失敗するため、必ずSQLを先に適用する。

### 本番確認

1. Stripeのテストイベントを1件送信し、`stripe_webhook_events.status` が `processed` になることを確認
2. 同じイベントを再送し、ユーザー・usageが重複更新されず200になることを確認
3. 一時的な処理失敗では `failed` と `last_error` が記録され、再送後に `processed` へ変わることを確認
4. `processing` が5分以上更新されていない場合、再送で処理を再取得できることを確認
5. 同一顧客に複数の有効契約がある場合、`users.plan` と `usage.limit_talks` が最上位プランになることを確認
6. 未登録のPrice IDだけを持つ有効契約では、既存ユーザーを `free` へ変更せずWebhookが `failed` になることを確認
7. Checkout完了後、Stripe Sessionの `metadata.user_id` と同じ `users.id` に `stripe_customer_id`、プラン、回数が反映されることを確認
8. Stripe側のメールアドレス表記が変わっていても、`metadata.user_id` が一致する利用者へ反映されることを確認
9. `metadata.user_id` が不正なイベントは別のメール利用者へ紐付かず、Webhookが `failed` になることを確認

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

初回反映時にSupabase SQL Editorで次を1回実行し、既存のfreeユーザーも0回へ統一する。このSQLは再実行可能で、コードとの適用順序は問わない。

```text
docs/sql/20260723_normalize_free_plan_quota.sql
```

1. `npm test`
2. `npx tsc --noEmit`
3. `npm run build`
4. 管理画面から新規ユーザーを同期し、`users.plan=free`、`monthly_quota=0` で作成されることを確認
5. 管理画面でプランを変更し、Free / Lite / Standard / Enterpriseがそれぞれ0 / 5 / 30 / 100回になることを確認
6. プラン未指定で新規登録し、メール認証後にトップのプラン選択が自動で開くことを確認
7. freeユーザーで `/chat` を直接開き、プラン選択が自動表示され、入力・送信できないことを確認
8. 無料体験を3回実行し、残回数が正しく減ることを確認
9. 4回目が回答生成されず、プラン案内になることを確認
10. 有料プランでログイン後チャットを1回実行
11. トップの無料体験直後に「出張日当を1日2万円にしても大丈夫ですか？」の相談例・回答例が表示されることを確認
12. 回答例の「自社の場合を相談してみる」で無料体験へ戻り、入力欄へフォーカスすることをPC・スマートフォンで確認
13. 無料体験の直前に、野口税理士の顔写真、肩書き、実務経験が表示されることを確認
14. 無料回答の箇条書きが「〜でも、」など文の途中で切れず、最後まで表示されることを確認
15. 金額相談で、提示額の成立可能性、主要条件、税務調査上の注意点が具体的に表示されることを確認
16. 1,200文字に近い回答でも、最後に会社別の確認質問が1〜3行表示されることを確認
17. 無料回答の直後に有料版で具体化できる4項目と「この相談の続きを整理する」が表示されることを確認
18. 「この相談の続きを整理する」でプランが開き、プラン欄へ移動することを確認
19. Vercelログに予期しないフォールバックやAPIエラーがないことを確認
20. PCで価値訴求と無料体験が左右2列に表示され、黒背景が使われていないことを確認
21. スマートフォンで価値訴求、信頼情報、無料体験が1列で読みやすく表示されることを確認
22. キーボード操作時に、ボタン・入力欄・リンクのフォーカス位置が視認できることを確認
23. 無料体験の回答生成を意図的に失敗させ、再送時に同じ回数枠を利用できることを確認
24. 無料体験の正常回答とガードレール遮断では、それぞれ1回分が消費されることを確認
25. 管理者で利用状況、プラン変更、ユーザー同期、無制限allowlist、知識管理を操作できることを確認
26. 非管理者・Bearer tokenなし・期限切れtokenが管理APIで403・401・401になることを確認

## 定期運用

- 月1回およびOpenAIから提供終了メールを受けた時に、公式Deprecationsページを確認する。
- 現行または予備モデルが終了対象なら、推奨後継を予備ENVの先頭へ追加する。
- 通常モデルの終了前に後継へ昇格する。忘れても実行時フォールバックで回答継続を優先する。
- 通常・予備の全候補が終了しても、一般向けGPTの自動探索を最後に実行する。ただし命名規則自体が変わった場合は自動探索できないため、公式告知の確認は継続する。
