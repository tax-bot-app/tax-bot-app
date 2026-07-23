# 有料プラン新料金への切替

## 変更内容

- Lite：月額1,480円（税込）／月5回
- Standard：月額4,800円（税込）／月30回
- Enterprise：月額9,800円（税込）／月100回
- 新規Checkoutで `PRICE_ID_*_NEXT` を使用
- Webhookは旧・現行・NEXTのPrice IDを引き続き認識
- 管理画面の想定売上を新料金へ更新
- 正本、RUNBOOK、決定ログを更新

## 本番反映前の条件

Vercel Productionに次の3つが設定済みであること。

- `PRICE_ID_LITE_NEXT`
- `PRICE_ID_STANDARD_NEXT`
- `PRICE_ID_ENTERPRISE_NEXT`

## 本番確認

1. 3プランの表示価格とStripe Checkout金額が一致する
2. 決済後に正しいプランと月間利用回数がDBへ反映される
3. Customer Portalに新料金の契約が表示される
4. 管理画面の想定売上が新料金で集計される
5. 問題がなければStripeの旧価格をアーカイブする
