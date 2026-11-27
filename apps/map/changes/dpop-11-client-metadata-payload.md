# SQL と KV のデータベースが、列の無いクライアントのメタデータも保存するようにする（DPoP の段 11）

DPoP（RFC 9449）を生成 OP に入れる段の 11 個目で、`--db sql` と `--db kv` の `registerClient()` が、列（KV ではレコードの項目）の無いクライアントのメタデータを捨てずに保存し、`findClient()` がそれを返すようにする。
RFC 9449 §5.2 のクライアントメタデータ `dpop_bound_access_tokens` は、段 21 で dpop の機能が `RegisteredClient` に足す。
`db/` のコードは機能を有効にしていない OP にもそのまま生成されるので、機能が足すメンバーの名前を書けない。そのため、これまでの SQL と KV は、列の無いメンバーをすべて落としていた。
memory のデータベースは登録内容を丸ごと持つので、静的に登録したクライアントの `dpop_bound_access_tokens` を、データベースの種類によって読めたり読めなかったりすることになる。
そこで、列の無いメンバーをまとめて JSON で持つ `payload` を、SQL の `clients` テーブルと KV のクライアントのレコードに足した。トークンやトランザクションのテーブルの `payload` と同じ考え方である。
これにより、前から落ちていた `defaultMaxAge`、`idTokenSignedResponseAlg`、`userinfoSignedResponseAlg` や、ciba の `backchannelTokenDeliveryMode` も残るようになる。
列のあるメタデータだけで登録したクライアントは、SQL では `payload` が NULL、KV では `payload` の無いレコードになり、読み出す `RegisteredClient` も前と変わらない。
`schema.sql` の文は `CREATE TABLE IF NOT EXISTS` なので、前の CLI で作った SQL のデータベースには `ALTER TABLE clients ADD COLUMN payload TEXT;` が要る（CLI の README と CLI のガイドに書いた）。
SQL のサンプル 3 つ（hono-cloudflare、express-flyio、fastify-flyio）の `instance.ts` は、`access_tokens.acr` と同じように、無い列を起動時に足す。

## createClientResolver <!-- hono:oidc-provider/db/sql/clients.ts#createClientResolver nextjs:app/_oidc-provider/db/sql/clients.ts#createClientResolver hono:oidc-provider/db/kv/clients.ts#createClientResolver nextjs:app/_oidc-provider/db/kv/clients.ts#createClientResolver -->

返すリゾルバの `findClient()` が、`payload`（SQL では `clients.payload` の JSON、KV ではレコードの `payload`）のメンバーを `RegisteredClient` に移すようにした。
`payload` は列から移す値より先に展開するので、同じ名前のメンバーは、列に値があれば列の値になる。`registerClient()` は列のあるメンバーを `payload` に書かないので、両方に同じ名前が入るのは、データベースを直に書き換えたときだけである。
SQL の `payload` が NULL の行（列を足しただけの前からの行や、`INSERT` 文で登録した行）と、KV の `payload` の無いレコードは、前と同じく列の値だけで読む。
`findClient()` は認可、トークン、UserInfo などのエンドポイントがクライアントを引くのに使うので、ここで返すメンバーが増えると、それを読む処理（`default_max_age` による再認証、ID トークンと UserInfo の署名アルゴリズム、CIBA の通知方式）が、memory のデータベースと同じように登録どおりに動く。
SQL と KV の `clients.test.ts` に、列の無いメタデータが読み戻せることと、列の値が `payload` の同じ名前のメンバーより優先することを確かめるテストを足した。

## registerClient, otherMetadataOf <!-- hono:oidc-provider/db/sql/clients.ts#registerClient nextjs:app/_oidc-provider/db/sql/clients.ts#registerClient hono:oidc-provider/db/kv/clients.ts#registerClient nextjs:app/_oidc-provider/db/kv/clients.ts#registerClient hono:oidc-provider/db/sql/clients.ts#otherMetadataOf nextjs:app/_oidc-provider/db/sql/clients.ts#otherMetadataOf hono:oidc-provider/db/kv/clients.ts#otherMetadataOf nextjs:app/_oidc-provider/db/kv/clients.ts#otherMetadataOf -->

`registerClient()` が、列にもクライアントのテーブルの行にもならないメンバーを `otherMetadataOf()` で取り出し、SQL では `clients.payload` に JSON で、KV ではレコードの `payload` に書くようにした。
`otherMetadataOf()` は、列や行になるメンバーを名前で除いた残りを返す。名前で列を選ぶのではなく残りを取るので、機能が `RegisteredClient` に足すメンバーも、`db/` のコードがその名前を知らずに残る。
`clientSecret`（保存しない）、`clientSecretHash`（シークレットの行やエントリーになる）、`keys`（公開鍵の行やレコードになる）は除くので、シークレットと公開鍵が `payload` に入ることはない。値が `undefined` のメンバーも除き、残りが無ければ SQL は NULL を書き、KV は `payload` を書かない。
同じ `client_id` で登録し直すと `payload` も置き換わり、列の無いメタデータを外して登録し直せば NULL（KV では `payload` の無いレコード）に戻る。前の登録を置き換えるほかの列と同じ扱いである。
SQL の `schema.sql`（と `schema.ts`）の `clients` には、NULL を許す `payload TEXT` を最後の列として足した。`ALTER TABLE … ADD COLUMN` で足した列も最後に来るので、前からのデータベースに列を足しても、新しく作ったデータベースと同じ列の並びになる。`schema.test.ts` で、`payload` が NULL で作られることと、この `ALTER TABLE` の文で同じ列になることを確かめる。
SQL と KV の `clients.test.ts` には、列の無いメタデータを保存すること、シークレットと公開鍵を入れないこと、列のあるメタデータだけなら書かないこと、登録し直しで置き換わることを確かめるテストを足した。
