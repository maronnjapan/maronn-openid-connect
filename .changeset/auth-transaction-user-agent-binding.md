---
'@maronn-openid-connect/core': minor
'@maronn-openid-connect/cli': minor
'@maronn-openid-connect/experimental': patch
---

認可トランザクションを、それを開始した User-Agent に Cookie で束縛する

OIDC Core 1.0 §3.1.2.3 / §3.1.2.4 は「認可リクエストを送ってきた User-Agent の End-User」を
認証し、その End-User から同意を得ることを前提とするが、同一性の保証手段は実装責務としている。
これまで生成 OP は `transaction_id`（URL を流れる値）だけで login / consent を進行できたため、
その値が漏れた場合に第三者が同意画面から CSRF トークンを取得してフローを完了させられた。
攻撃者が自分のクライアントで開始したトランザクションへ被害者を誘導すれば、被害者 identity の
認可コードを攻撃者のクライアントへ届かせることもできた（RP 側の `state` 検証では防げない）。

core:

- `AuthTransaction.bindingHash`（任意）を追加
- `computeTransactionBindingHash()` / `validateTransactionBinding()` を追加。比較は
  `timingSafeEqual` を使い、生の秘密値ではなく SHA-256 ハッシュのみを保存する
- `AuthTransactionErrorCode.InvalidTransactionBinding`（HTTP 400）を追加
- `createAuthTransaction()` の第 3 引数がオプションオブジェクト
  （`{ ttlMs?, bindingHash? }`）を受け取れるようになった。数値 TTL を渡す既存の呼び出しは
  そのまま動作する

cli（hono / express / fastify / nextjs のすべてに適用）:

- 認可エンドポイントが CSPRNG 由来の秘密値を HttpOnly / Secure / SameSite=Lax な
  `oidc_txn_<transaction_id>` Cookie で発行する。Cookie 名をトランザクションごとに分けるため、
  複数タブでの同時フローが壊れない
- GET / POST の `/login`・`/consent` が、CSRF トークンを HTML に出す前・検証する前に束縛を
  検証する。不一致・欠落時はクライアントへリダイレクトせず OP 自身の 400 エラーページで止める
- 完了・拒否時に該当トランザクションの Cookie を破棄する
- 生成される `conformance.test.ts` に束縛の契約テストを追加した
