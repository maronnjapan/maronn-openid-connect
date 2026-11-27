---
'@maronn-openid-connect/cli': patch
---

生成コードが、認可リクエストを鍵に束縛したとき、その確認（`cnf`）を認可トランザクションから、そこから発行する認可コードのレコードへ引き継ぐようにする（RFC 9449 §10）。後の段で加える DPoP（RFC 9449）の機能が、認可リクエストの `dpop_jkt` の鍵をトランザクションに入れ、トークンエンドポイントで認可コードの鍵と DPoP proof の鍵を照らし合わせられるようにするためである。

- 本体のモジュール `token-binding.ts` に、レコードの `cnf` を別のレコードへ展開できる形で返す `confirmationRecordOf()` を足す。`cnf` が無いか JSON のオブジェクトでなければ、空のオブジェクトを返す。
- Hono（Express、Fastify を含む）の認可エンドポイントのステップ `createAuthorizationTransaction()` は、省略できる 4 つ目の入力 `codeConfirmation` を受け取り、渡されたときはそれを `cnf` としてトランザクションに入れる。ステップの説明の入力には、省略できる `codeConfirmation` が加わる。
- 認可コードを発行するところ（Hono の `issueAuthorizationCodeResponse()` と `issueConsentedAuthorizationCode()`、Next.js の `authorize/route.ts` と `consent/decision/route.ts`、両方の `hybrid-flow` 機能）は、トランザクションの `cnf` を認可コードのレコードに入れる。`hybrid-flow` 機能の `issueHybridTokens()` は、そのための省略できる入力 `codeConfirmation` を受け取る。

今はどのブロックもトランザクションに `cnf` を入れないので、トランザクションと認可コードのレコード、認可レスポンスは変わらない。
独自のコードでトランザクションに `cnf` を保存している場合は、そのトランザクションから発行する認可コードのレコードにも `cnf` が入る。トークンエンドポイントはまだ認可コードの `cnf` を確かめないので、そうした認可コードも今までどおり DPoP proof なしで交換できる。
