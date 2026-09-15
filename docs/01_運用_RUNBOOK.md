# さじかげん｜運用RUNBOOK

## GitHub更新の標準フロー（ChatGPT＋GitHub Desktop）

### 目的と役割分担

- ChatGPTは、GitHubの現行コードを作業用コピーで確認し、必要なファイルだけを最小差分で編集・検証して、上書き用ZIPを作る。
- 利用者は、GitHub Desktopで変更内容を確認し、原則としてCommitとPushだけを行う。
- ChatGPTは、利用者から明示的な依頼がない限り、GitHubへのCommit、Push、ブランチ変更、PR作成、Vercel本番設定の変更を行わない。

### 1. GitHubの現行ファイルを渡す

1. GitHub Desktopで対象リポジトリとブランチを確認する。通常は `main` を使用する。
2. `Fetch origin` を実行し、更新があれば `Pull origin` を行う。
3. GitHub Desktopの `Changes` に未Commitの変更がないことを確認する。残っている場合は、今回の更新と混ぜず、先に内容を確定する。
4. GitHubの対象リポジトリをブラウザで開き、`Code` → `Download ZIP` から最新版を取得し、ZIPのままChatGPTへ添付する。
5. 変更したい内容、変更してよい範囲、触ってはいけない機能、完了条件をChatGPTへ伝える。

補足：

- Project Filesは仕様と運用ルールの情報源であり、GitHub上の現行コードそのものとは限らない。ChatGPTはProject Filesだけを根拠に現行コードを書き換えない。
- ChatGPTが認証済みのGitHub機能で対象リポジトリを直接確認できる場合は、最新版ZIPの添付を省略できる。ただし、作業前に対象リポジトリ、ブランチ、取得時点を確認する。
- 一部ファイルだけを渡す方法は、影響範囲がそのファイル内で完結すると確認できる場合に限る。不明な場合はリポジトリ全体のZIPを使用する。

### 2. ChatGPT側で編集する

1. 受け取った現行コードを作業用フォルダへ展開し、元のZIPは変更しない。
2. リポジトリ直下の `AGENTS.md`、`docs/00_憲法_確定仕様.md`、`docs/01_運用_RUNBOOK.md`、`docs/04_決定ログ.md` を先に確認する。
3. 変更対象と、認証・Stripe・Supabase・API・middleware／proxy・画面導線などへの影響範囲を特定する。
4. 必要なファイルだけを最小差分で編集する。無関係な整形、ファイル全体の書き直し、命名変更、依存更新、リファクタは同時に行わない。
5. スレッドで新たに確定した仕様は、正本と決定ログへ反映する。運用手順が変わる場合はRUNBOOKも更新する。
6. 利用者が作成した既存変更や、今回と無関係なファイルは保持する。競合や想定外の差分が見つかった場合は、勝手に上書きせず作業を止めて確認する。

### 3. ChatGPT側で検証する

変更内容に応じて、原則として次を実行する。

```text
npm test
npx tsc --noEmit
npx eslint <変更対象ファイル>
npm run build
```

- 既存のLint違反と今回追加した違反を分けて報告する。今回と無関係な既存違反を、ついでに修正しない。
- ローカル環境にENVがないためビルドできない場合は、コード不良と区別して報告する。本番ENVをファイルへ書き込んだり、値を推測したりしない。
- ビルド確認に公開用の非秘密プレースホルダーが必要な場合は、コマンド実行時だけ使用し、`.env` やソースへ保存しない。
- 最後に変更ファイル一覧、ファイル数、差分内容、ZIP内の階層、意図しない削除、秘密情報の混入がないことを確認する。

### 4. 変更後のファイルを受け取る

ChatGPTは、次の条件を満たす上書き用ZIPを返す。

- 変更・追加が必要なファイルだけを含める。
- `app/...`、`public/...`、`docs/...` など、リポジトリ直下からの相対階層を維持する。
- `.git`、`node_modules`、`.next`、ログ、キャッシュ、作業用ファイル、`.env` 系ファイルを含めない。
- ZIPと一緒に、変更内容、変更ファイル数、検証結果、反映順序、短い英語のCommit Summaryを提示する。
- SQL適用やENV名の追加など、Push以外の作業が必要な場合は、実行順序を明記する。秘密の値は含めない。

### 5. GitHub Desktopで反映する

1. GitHub Desktopで対象リポジトリとブランチが正しいことを再確認する。
2. ZIPを展開し、中のファイルとフォルダを対象リポジトリ直下へコピーして上書きする。
3. GitHub Desktopの `Changes` で、ChatGPTが案内したファイルだけが変更されていることを確認する。
4. 各ファイルの差分を確認し、意図しない削除、全文置換、文字化け、価格・回数・URL・画面文言の誤変更がないことを確認する。
5. ChatGPTが提示したCommit Summaryを入力し、`Commit to main` を実行する。
6. `Push origin` を実行する。
7. VercelのDeploymentが `Ready` になったことを確認し、案内された本番確認を行う。

### 6. Push前の停止条件

次のいずれかに該当する場合はCommit／Pushせず、ChatGPTへ画面または状況を共有する。

- ChatGPTの案内より変更ファイルが多い、または不足している。
- 削除予定のないファイルが削除表示になっている。
- `.env`、秘密鍵、APIキー、Bearer token、Webhook secretなどの値が差分に含まれている。
- 作業前からの未Commit変更が混ざっている。
- ZIP取得後にGitHub側が更新され、元にしたコードが最新版ではなくなった。
- 競合表示、ビルド失敗、認証・決済・無料体験など主要導線の想定外変更がある。

最新版ではなくなった場合は、古いZIPへ継ぎ足さず、GitHubから新しいZIPを取得して同じ変更を作り直す。

## 問い合わせ・不適切回答報告の確認

1. ログイン済み利用者で、問い合わせ、要望、不適切回答報告を各1件送信できることを確認
2. 不適切回答報告に対象回答と直前の会話文脈が従来どおり保存されることを確認
3. 送信履歴に自分の送信内容だけが新しい順で表示されることを確認
4. Bearer tokenなし・期限切れtokenで送信と履歴取得を呼び、401の固定案内になることを確認
5. 30文字未満と4,000文字超の本文が400で拒否されることを確認
6. 60秒以内の連続送信が429で拒否されることを確認
7. DB取得・保存を意図的に失敗させ、画面とレスポンスにSupabase、ENV、内部テーブル等のエラー本文が出ないことを確認
8. Vercelログに本文、会話内容、Bearer token、メールアドレス、エラー本文、スタックが出ていないことを確認

## OpenAI Ads Pixel

### Vercel設定

1. Vercel Productionに `NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID` を設定する。
2. 値にはOpenAI Ads Managerで作成した公開用Pixel IDを使用する。
3. 設定後にProductionをRedeployする。
4. `debug` 用のENVや秘密値は追加しない。

### 本番確認

1. VercelのDeploymentが `Ready` になったことを確認する。
2. 本番サイトを通常のブラウザで1回開く。
3. ブラウザのNetworkで `https://bzrcdn.openai.com/sdk/oaiq.min.js` が正常取得されることを確認する。
4. ConsoleでOpenAI Ads Pixelの読込エラーや初期化エラーが出ていないことを確認する。
5. ページ内遷移や再描画でSDKの読込・初期化が重複していないことを確認する。
6. OpenAI Ads Managerのイベントストリームで、Pixelからの受信を確認する。反映に時間がかかる場合は、二重実装せず時間を置いて再確認する。
7. Meta PixelのPageView／既存イベントとGoogle Adsの計測が従来どおり動作することを確認する。

この段階では `DemoSubmit`、`PlanView`、`Checkout`、`Purchase` を送信しない。Pixel本体の受信確認後、イベント実装を別リリースで行う。

## 無料体験APIの内部エラー非表示確認

1. 空回答を発生させ、画面に英語の内部文言やOpenAI・Supabaseのエラー本文が表示されず、回答作成失敗の固定案内になることを確認
2. タイムアウトを発生させ、混雑時の固定案内になり、確保した無料体験枠が解放されることを確認
3. 予期しない例外を発生させ、固定の再試行案内になり、確保した無料体験枠が解放されることを確認
4. Vercelログにエラー本文、スタック、原因、質問本文、端末識別情報、鍵、メールアドレスが出ていないことを確認
5. 正常回答とガードレール遮断では、従来どおり各1回分が消費されることを確認

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

## 管理APIの内部エラー非表示確認

1. テスト環境で利用状況または知識管理のDB取得を意図的に失敗させ、管理画面には固定の再試行案内だけが表示されることを確認
2. chat-debug一覧とCSVのDB取得を意図的に失敗させ、Supabase、ENV、テーブル名、SQL、エラー本文がレスポンスへ含まれないことを確認
3. Bearer tokenなし、期限切れtoken、非管理者では、従来どおり401、401、403になることを確認
4. 入力不備では各管理APIの従来の400案内が表示されることを確認
5. Vercelログには処理段階と `name`、`code`、`type`、`status`、`request_id` だけが残り、エラー本文、スタック、原因、Bearer token、メールアドレス、相談内容が出ていないことを確認
6. 正常時の利用状況、プラン変更、ユーザー同期、無制限allowlist、知識管理、chat-debug一覧・CSVが従来どおり動作することを確認

## 有料チャットの回数上限確認

1. 当月残回数が1回のテストユーザーで相談し、回答成功後に残回数が0になることを確認
2. 同じユーザーでもう一度相談し、AI回答が生成されず回数上限の案内になることを確認
3. Vercelログで、2回目の相談についてOpenAI呼び出しが開始されていないことを確認
4. 無制限対象ユーザーでは、通常どおり回答できることを確認

補足：

- この事前確認は、すでに上限へ達している通常リクエストの無駄なAI生成を止めるためのもの。
- 同時に到達した複数リクエストの最終判定は、回答生成後の `consume_talk_v2` が行う。

## 有料チャットの内部エラー非表示確認

1. テスト環境でプラン取得または利用状況取得を意図的に失敗させ、画面にテーブル名、SQL、ENV名、Supabaseのエラー文が表示されないことを確認
2. OpenAI呼び出しを意図的に失敗させ、固定の再試行案内だけが表示され、回答回数が消費されないことを確認
3. `consume_talk_v2` を意図的に失敗させ、内部RPC名やDBエラー文が画面へ表示されないことを確認
4. 無制限判定の取得失敗時に通常利用者として処理が続かず、利用状況確認エラーになることを確認
5. Vercelログには処理段階と `name`、`code`、`status` 等だけが残り、質問本文、回答、Bearer token、メール、鍵、内部エラー本文が出ていないことを確認
6. 回数更新RPCが空結果を返す場合も、画面には利用回数更新の固定案内だけが表示されることを確認
7. 正常な相談後もVercelログへ会話トレース、質問本文、回答全文が出ておらず、管理画面のchat-debugには従来どおり記録されることを確認

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

### Stripe系APIの内部エラー非表示確認

1. テスト環境でCheckout Session作成を意図的に失敗させ、画面には決済画面を準備できない旨の固定案内だけが表示されることを確認
2. Customer Portal Session作成を意図的に失敗させ、画面には請求情報を開けない旨の固定案内だけが表示されることを確認
3. Webhookの署名検証と処理をそれぞれ失敗させ、レスポンスへStripe・Supabase・ENV・内部テーブルのエラー本文が含まれないことを確認
4. Vercelログにメールアドレス、User ID、Customer ID、Subscription ID、Session ID、Price ID、Event ID、生のエラー本文が出ていないことを確認
5. 失敗したWebhookの `stripe_webhook_events.last_error` が、安全な診断項目だけのJSONになっていることを確認
6. 正常なCheckout、Customer Portal、Webhook処理とStripe再送が従来どおり動作することを確認

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
11. トップの無料体験直後に、出張日当2万円と高級クラブ20万円の相談例・回答例が2本表示されることを確認
12. 2本とも無料の主要論点、ロック表示、自社条件で具体化できる箇条書き、CTAの順に表示され、「自社の場合を相談してみる」で無料体験へ戻って入力欄へフォーカスすることをPC・スマートフォンで確認
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
27. トップのフッターに運営法人、代表、所在地、GLADZ公式サイト、FAQ、ログイン、利用規約、プライバシーポリシー、販売・提供条件が表示されることを確認
28. GLADZ公式サイトが新しいタブで開き、内部リンクがそれぞれ正しいページへ遷移することを確認
29. フッターがPCで3列、スマートフォンで1列となり、文字やリンクが画面外にはみ出さないことを確認
30. 無料体験の直後、相談例の前にサービスフローが表示され、PCでは一枚絵、スマートフォンでは4場面が縦に並び、文字が読めることを確認
31. サービスフロー画像の追加後も、無料体験送信、相談例CTA、プラン表示、Checkoutへの遷移が従来どおり動くことを確認

## 定期運用

- 月1回およびOpenAIから提供終了メールを受けた時に、公式Deprecationsページを確認する。
- 現行または予備モデルが終了対象なら、推奨後継を予備ENVの先頭へ追加する。
- 通常モデルの終了前に後継へ昇格する。忘れても実行時フォールバックで回答継続を優先する。
- 通常・予備の全候補が終了しても、一般向けGPTの自動探索を最後に実行する。ただし命名規則自体が変わった場合は自動探索できないため、公式告知の確認は継続する。
