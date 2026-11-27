---
'@maronn-openid-connect/cli': minor
---

`--db sql` と `--db kv` の生成コードが、列（KV ではクライアントのレコードの項目）の無いクライアントのメタデータを捨てずに保存し、クライアントを読むときにそのまま返すようにする。後の段で加える DPoP（RFC 9449）の機能が `RegisteredClient` に足すクライアントメタデータ `dpop_bound_access_tokens`（RFC 9449 §5.2）を、どのデータベースでも登録どおりに読めるようにするためである。

- `--db sql` の `schema.sql` の `clients` に、NULL を許す `payload TEXT` 列を足す。`registerClient()` は、`defaultMaxAge`、`idTokenSignedResponseAlg`、`userinfoSignedResponseAlg` や、ciba の `backchannelTokenDeliveryMode` のように機能が `RegisteredClient` に足すメタデータを、この列に JSON で書き、`findClient()` はそれを `RegisteredClient` に戻す。列のあるメタデータは今までどおり列に書き、列に値があれば `payload` の同じ名前のメンバーより列を優先する。
- `--db kv` のクライアントのレコード（`ClientRecord`）に、省略できる `payload` を足す。中身と読み方は `--db sql` と同じで、残すメタデータが無ければ書かない。
- `clientSecret` と公開鍵（`keys`）は `payload` に入れない。JSON で表せない値（関数など）は残らない。

これまで `--db sql` と `--db kv` では、上のメタデータを登録しても既定値で動いていた（`default_max_age` による再認証をしない、ID トークンを RS256 で署名する、など）。今後は、登録したクライアントは memory のデータベースと同じく登録どおりに動く。起動のたびに `registerClient()` でこうしたメタデータを登録している場合は、新しい生成コードで最初に登録したときから、その値が効く。たとえば `idTokenSignedResponseAlg: 'ES256'` のクライアントは、ES256 の ID トークンの署名鍵が無ければ、RS256 で署名する代わりに `server_error` になる。列のあるメタデータだけで登録したクライアントは、前と変わらない。

`schema.sql` は `CREATE TABLE IF NOT EXISTS` なので、以前の CLI で作った `--db sql` のデータベースに実行し直しても `payload` 列は増えない。新しい生成コードでクライアントを登録したり読んだりする前に、次の文で列を足す。列が無いままだと、クライアントを読む SQL 文が失敗する。

```sql
ALTER TABLE clients ADD COLUMN payload TEXT;
```

列を足しただけのクライアントは `payload` が NULL なので、これまでどおり読まれる。列の無いメタデータを持たせるには、`registerClient()` で登録し直す。`--db kv` は移行が要らない。`payload` の無い既存のレコードは、これまでどおり読まれる。
