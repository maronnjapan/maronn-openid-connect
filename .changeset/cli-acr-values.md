---
'@maronn-openid-connect/cli': minor
---

生成する OP で `acr_values` を検証し、決めた acr を ID Token とアクセストークンに載せて、アクセストークンの保存レコードにも残す

- `/authorize` は core の `validateAcrValuesParameter()` で `acr_values` を検証する。省略してよい。空白区切りの各値に `"`、`\`、制御文字、非 ASCII 文字が含まれると、`invalid_request` をクライアントへ返す
- `/token` に、トークンの acr / amr を決めるステップ `resolve-acr-amr`（Hono / Express / Fastify では `routes/token.ts` の `resolveTokenAcrAmr()`）を `issue-access-token` の前に加えた。`acrResolver` を渡していればその戻り値を使い、渡していなければ要求された値のうち最も優先する値を acr にする。要求が無ければ acr を載せない。リフレッシュでは最初に決めた acr / amr を引き継ぐ。これまで `issueIdToken()` の中で決めていた acr / amr は、このステップの結果を受け取る形にした
- 決めた acr は、ID Token の `acr`、JWT アクセストークンの `acr`（RFC 9068 §2.2.1）、アクセストークンの保存レコードに入り、イントロスペクションのレスポンスにも `acr`（RFC 9470 §6.2）として現れる
- Next.js の生成物は、`_oidc-provider/provider.ts` の `acrResolver` で acr / amr を決め、アクセストークンにも同じ acr を載せる。`acrResolver` は core の `selectPreferredAcr()` を使う形にした
- `--db sql` の `access_tokens` に `acr` 列（`VARCHAR(5000)`）を、`--db kv` の `AccessTokenRecord` に `acr` を加えた
- `resolve-acr-amr` は `removable: true` で、`--flow` で外すとトークンに acr を載せない OP になる。`issue-access-token` より後ろには置けない。`resolve-subject` のラベルは、解決する値に合わせて「Resolve the subject, auth_time and nonce」に変えた

`schema.sql` は `CREATE TABLE IF NOT EXISTS` なので、以前の CLI で作った `--db sql` のデータベースに実行し直しても `acr` 列は増えない。新しい生成コードでトークンを発行する前に、次の文で列を足す。

```sql
ALTER TABLE access_tokens ADD COLUMN acr VARCHAR(5000);
```

`--db kv` は移行が要らない。`acr` の無い既存のレコードは acr の無いトークンとして読まれ、アクセストークンの期限が来ると消える。

`acrResolver` を渡していない Hono / Express / Fastify の OP は、これまで `acr_values` を要求されても ID Token に acr を載せなかったが、今後は最も優先する要求値を載せる。要求された値をそのまま acr にした場合、その acr は OP が実際に行った認証を表すとは限らないので、ログインの方式に合った acr を返すときは `acrResolver` を渡す。
