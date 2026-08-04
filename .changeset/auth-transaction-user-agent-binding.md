---
'@maronn-openid-connect/core': minor
'@maronn-openid-connect/cli': minor
'@maronn-openid-connect/experimental': patch
---

認可トランザクションを User-Agent に Cookie で束縛する opt-in 機能を追加する（`--enable transaction-binding`）

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

- **`--enable transaction-binding` で有効化する opt-in 機能**として追加した。stable / 実装は
  core 側だが、`AVAILABLE_FEATURES`（既定 ON）でも `EXPERIMENTAL_FEATURES` でもない第 3 の
  カテゴリ `OPTIONAL_FEATURES` を新設し、そこに置いている。既定を OFF にしたのは、
  この束縛を要求する OIDC Core / OAuth 2.1 の条文が無く、既定生成物は「仕様そのもの」に
  保ちたいため。加えて有効時は Cookie の持ち回りが要るので、curl で `/authorize` →
  `/login` と手で辿る検証フローが 400 で止まってしまう
- 有効時: 認可エンドポイントが CSPRNG 由来の秘密値を HttpOnly / Secure / SameSite=Lax な
  `oidc_txn_<transaction_id>` Cookie で発行する。Cookie 名をトランザクションごとに分けるため、
  複数タブでの同時フローが壊れない
- GET / POST の `/login`・`/consent` が、CSRF トークンを HTML に出す前・検証する前に束縛を
  検証する。不一致・欠落時はクライアントへリダイレクトせず OP 自身の 400 エラーページで止める
- 完了・拒否時に該当トランザクションの Cookie を破棄する
- 無効時（既定）: 束縛関連のコードは 1 行も生成されない。生成される `conformance.test.ts` は
  「Cookie を一切送らずにフロー全体を完走できる」ことを契約として固定するため、将来これが
  無条件で有効化されると失敗する
- 有効時: 生成される `conformance.test.ts` に束縛の契約テストを追加した
