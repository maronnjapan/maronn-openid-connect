---
"@maronn-openid-connect/cli": minor
"@maronn-openid-connect/google-login": patch
---

ログイン・同意画面の認可トランザクションを、URL のクエリではなく Cookie と HTML の csrf_token で引き継ぐ

これまで生成コードは、`/authorize` から `/login`・`/consent` へ認可トランザクションの ID を `?transaction_id=` として URL に載せ、フォームにも hidden の `transaction_id` を埋め込んでいた。URL に載った ID はブラウザ履歴・アクセスログ・画面共有から漏れ、漏れた ID があれば第三者が同意画面を開いて `csrf_token` を読み、フローを完了できる。攻撃者が自分のクライアントで始めたトランザクションへ被害者を誘導し、被害者の認可コードを攻撃者のクライアントへ届かせることもできる。これを防ぐ Cookie による束縛は、opt-in の `--enable transaction-binding` でしか生成していなかった。

生成コードは常に次の形で認可トランザクションを引き継ぐ。

- `/authorize` はトランザクションの ID を HttpOnly Cookie `oidc_txn`（`Secure; SameSite=Lax; Path=/; Max-Age=600`）だけでブラウザに渡し、クエリの無い `/login`（SSO で同意だけが残っている場合は `/consent`）へリダイレクトする
- `/login`・`/consent` は Cookie からトランザクションを引き、フォームには `csrf_token` だけを埋め込む
- `POST /login`・`POST /consent` は、Cookie が指すトランザクションに対して送られた `csrf_token` を照合する。Cookie が無い・トランザクションが無い場合は 400（Next.js は `not-found.tsx` の 404）、`csrf_token` が一致しない場合は 403（Next.js は `oidc-error`）を OP 自身の画面で返し、クライアントへはリダイレクトしない
- 同意の結果をクライアントへ返すときに Cookie を消す

Cookie はブラウザに 1 つなので、同じブラウザの別タブで新しい認可リクエストを始めると、先のタブのフォームは `csrf_token` が一致せず拒否される。

google-login の README は、生成コードのトランザクション Cookie と `/login/google` の関係の説明に更新した。

## 破壊的変更

- **cli: `--enable transaction-binding` を削除した**。トランザクションの ID が Cookie にしか載らなくなり、Cookie 自体が User-Agent への束縛になったため。指定すると未知の機能としてエラーになる。Optional 機能のカテゴリもあわせて削除し、生成マニフェスト（`.maronn-openid-connect.json`）の `features` から `transactionBinding` がなくなった
- **cli: `/login`・`/consent` の URL とフォームから `transaction_id` を削除した**。ログイン・同意画面を差し替えている場合は hidden の `transaction_id` を外し、`csrf_token` だけを送る。`LoginPageParams` / `ConsentPageParams`、`LoginScreen` / `ConsentScreen`、`LoginSubmission` / `ConsentSubmission` から `transactionId` を、`prepareLogin()` / `prepareConsent()` から `transactionId` 引数を、`AuthorizationOutcome` の `login` / `consent` と `LoginOutcome` / `GoogleLoginOutcome` の `authenticated` から `transactionId` を削除した。Next.js の `requireTransaction()` は引数を取らず、Cookie から `{ transactionId, transaction }` を返す
- **cli: curl などで手動でフローを進めるときは Cookie を持ち回る必要がある**（`curl -c jar.txt -b jar.txt`）
