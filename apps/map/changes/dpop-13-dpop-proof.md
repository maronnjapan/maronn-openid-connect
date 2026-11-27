# DPoP proof の検査を足す（DPoP の段 13）

DPoP（RFC 9449）を生成 OP に入れる段の 13 個目で、DPoP の機能のディレクトリに、リクエストの `DPoP` ヘッダーの DPoP proof を検査するモジュール（`proof.ts`）と、`htu` を比べるための URI の正規化（`htu.ts`）を足す。
RFC 9449 §4.3 の検査は責務ごとの関数に分けた。`readDpopProofHeader()` が `DPoP` ヘッダーが一つであることを確かめて DPoP proof を取り出し、`verifyDpopRequestProof()` が残りの検査（JWS の形と `typ`、`alg`、`jwk` の公開鍵での署名、`jti`、`htm`、`htu`、`iat`、保護されたリソースでの `ath`、`jti` の再利用）を順に呼んで、DPoP proof の鍵の JWK Thumbprint を返す。
`iat` の範囲は、`dpopSigningAlgValuesSupported` と同じく `ProviderConfig` の必須の項目（`dpopProofMaxAgeSeconds`、`dpopProofLeewaySeconds`、既定はどちらも 60 秒）として `config.ts` で宣言し、既定値を `dpopConfigDefaults` に足した。
エンドポイントから呼ぶのは後の段で、この段ではまだどこからも読み込まない。CLI の機能の一覧に `dpop` が無いので、どの生成にも入らず、生成するコードも OP の応答も変わらない。
PR #205 の `proof.ts` と `htu.ts` をもとにし、そこで見つかった三つの不備（`jti` の長さに上限が無くそのまま覚えること、`/` で終わる issuer での `htu` の比べ方、`typ` の `application/dpop+jwt` を拒否すること）を直した。
Hono と Next.js のファイルは、設定とストアの読み方（Hono はリクエストのコンテキスト、Next.js は `provider.ts`）のほかは同じ中身である。

## normalizeDpopHtu <!-- hono:oidc-provider/features/dpop/htu.ts#normalizeDpopHtu nextjs:app/_oidc-provider/features/dpop/htu.ts#normalizeDpopHtu -->

`htu` とエンドポイントの URI を比べる前に、両方を同じ形にそろえる。
RFC 9449 §4.3 が、比べる前に構文に基づく正規化（RFC 3986 §6.2.2）とスキームに基づく正規化（RFC 3986 §6.2.3）を行うよう求める（SHOULD）ためで、同じ URI を別の書き方で送るクライアントを誤って拒否しないようにする。
スキームとホストの大文字と小文字、既定のポート、空のパス、`.` と `..` のセグメントは WHATWG URL の解析にそろえさせ、パーセントエンコーディングの 16 進数の大文字と、予約されていない文字のパーセントエンコーディングはここでそろえる。
クエリとフラグメントは比較に使わない（RFC 9449 §4.2 / §4.3）ので除く。
パスの大文字と小文字と、重なった `/` はそろえない。どちらも RFC 3986 では別のパスだからである。

## readDpopProofHeader, invalidProof <!-- hono:oidc-provider/features/dpop/proof.ts#readDpopProofHeader hono:oidc-provider/features/dpop/proof.ts#invalidProof nextjs:app/_oidc-provider/features/dpop/proof.ts#readDpopProofHeader nextjs:app/_oidc-provider/features/dpop/proof.ts#invalidProof -->

`DPoP` ヘッダーが一つだけで、一つの JWT であることを確かめる（RFC 9449 §4.3）。
Fetch API の `Headers` は同じ名前のヘッダーを `, ` でつないだ一つの値にし、JWS のコンパクト形式は `,` を含まないので、`,` を含む値を二つ以上のヘッダーとして拒否する。
検査の失敗はどれも `invalid_dpop_proof`（RFC 9449 §5 / §7.1）で、説明には検査が決めた固定の文言だけを入れる（`invalidProof()`）。後の段でエンドポイントがこの失敗を答えるとき、`error_description` と `WWW-Authenticate` の値にクライアントの送った文字が入らないようにするためである。

## decodeDpopProof, decodeJsonObject <!-- hono:oidc-provider/features/dpop/proof.ts#decodeDpopProof hono:oidc-provider/features/dpop/proof.ts#decodeJsonObject nextjs:app/_oidc-provider/features/dpop/proof.ts#decodeDpopProof nextjs:app/_oidc-provider/features/dpop/proof.ts#decodeJsonObject -->

DPoP proof を JWS のコンパクト形式として分解し、JOSE ヘッダーが `typ`、`alg`、`jwk` を持つことを確かめる（RFC 9449 §4.2 / §4.3）。
理解する拡張が無いので、`crit`（RFC 7515 §4.1.11）のある DPoP proof は拒否する。

PR #205 から、`typ` に `application/dpop+jwt` も受け付けるようにした。
`typ` はメディアタイプで、`/` を含まない値は `application/` を付けたものとして扱う（RFC 7515 §4.1.9）ので、`dpop+jwt` と `application/dpop+jwt` は同じ型である。メディアタイプは大文字と小文字を区別しないので、比べる前に小文字にする（これは PR #205 も行っていた）。
`application/jwt` や `text/dpop+jwt` のような別の型は、これまでどおり拒否する。

## validateDpopProofAlg, verifyDpopProofSignature <!-- hono:oidc-provider/features/dpop/proof.ts#validateDpopProofAlg hono:oidc-provider/features/dpop/proof.ts#verifyDpopProofSignature nextjs:app/_oidc-provider/features/dpop/proof.ts#validateDpopProofAlg nextjs:app/_oidc-provider/features/dpop/proof.ts#verifyDpopProofSignature -->

`alg` が、この実装が検証できる非対称鍵の署名で、OP の受け付ける alg（`dpopSigningAlgsOf()` の値）にあることを確かめ（RFC 9449 §4.3）、`jwk` ヘッダーの公開鍵で署名を検証する。
署名の検証は前の段の `verifyJwsSignature()` に任せ、検証できなければ `invalid_dpop_proof` にする。署名を検証するまで、ペイロードのクレームは信用しない。

## validateDpopProofClaims <!-- hono:oidc-provider/features/dpop/proof.ts#validateDpopProofClaims nextjs:app/_oidc-provider/features/dpop/proof.ts#validateDpopProofClaims -->

`jti`、`htm`、`htu`、`iat` を確かめ、`jti` を覚えておく期限を返す（RFC 9449 §4.2 / §4.3 / §11.1）。
`iat` は、`now - maxAge - leeway` から `now + leeway` までを受け付ける。`jti` を覚える期限は、受け付ける最後の秒の次の秒にした。`jti` のストアは期限の時刻になった値を忘れてよいので、最後の秒を期限にすると、その秒の再利用を見逃すためである。
`htu` は、エンドポイントの URI のどれか一つと、正規化してから比べる（URI が二つになるのは、`/` で終わる issuer のときである。`verifyDpopRequestProof` の節）。
`maxAge` か `leeway` が 0 以上の有限の数でないときは、クレームを確かめずに `Error` を投げ、DPoP proof を受け付けない。設定に項目が無い（`undefined`）か `NaN` のままでは、`iat` の比較がどれも偽になってどの `iat` も受け付け、`jti` を覚える期限も `NaN` になってメモリのストアが再利用を見逃すためである。クライアントの誤りではなく設定の誤りなので、`invalid_dpop_proof` の `DpopError` にはしない。
PR #205 は、この二つが無いときに関数の中の既定値で補っていた。この段は既定値を `dpopConfigDefaults` だけに置いたので、補う代わりに止める。

PR #205 から、256 文字より長い `jti` を拒否するようにした。
RFC 9449 §11.1 は、`jti` を覚えるサーバーに、必要以上に大きな `jti` を拒否するか、そのハッシュだけを覚えるよう求める。この実装は両方を行う（ハッシュは `consumeDpopProofJti` の節）。
RFC 9449 §4.2 が `jti` の作り方に挙げる、96 ビット以上の乱数の base64url（96 ビットなら 16 文字）や UUID（36 文字）には、256 文字で十分に足りる。

## computeDpopAccessTokenHash, validateDpopProofAccessTokenHash, sha256Base64Url <!-- hono:oidc-provider/features/dpop/proof.ts#computeDpopAccessTokenHash hono:oidc-provider/features/dpop/proof.ts#validateDpopProofAccessTokenHash hono:oidc-provider/features/dpop/proof.ts#sha256Base64Url nextjs:app/_oidc-provider/features/dpop/proof.ts#computeDpopAccessTokenHash nextjs:app/_oidc-provider/features/dpop/proof.ts#validateDpopProofAccessTokenHash nextjs:app/_oidc-provider/features/dpop/proof.ts#sha256Base64Url -->

保護されたリソースへの DPoP proof の `ath` が、一緒に提示されたアクセストークンの SHA-256 の base64url であることを確かめる（RFC 9449 §4.2 / §4.3 / §7）。
`ath` は、アクセストークンと一緒に送る DPoP proof だけのクレームなので、`verifyDpopRequestProof()` はアクセストークンを渡されたときだけ確かめる。
テストでは、RFC 9449 §7.1 の例のアクセストークンのハッシュが、例の `ath` と一致することを確かめた。
`sha256Base64Url()` は、`ath` と `jti` のハッシュの両方が使う計算である。

## consumeDpopProofJti <!-- hono:oidc-provider/features/dpop/proof.ts#consumeDpopProofJti nextjs:app/_oidc-provider/features/dpop/proof.ts#consumeDpopProofJti -->

受け付けた DPoP proof の `jti` を、DPoP proof を受け付ける期間だけ覚え、同じ DPoP proof の再提示を拒否する（RFC 9449 §11.1）。
ストアは、private_key_jwt のクライアントアサーションの `jti` を覚える `clientAssertionJtiStore` を使う。DPoP のためにストアやテーブルを増やさずに、メモリ、SQL、KV のどの DB でも同じに動かすためである。
キーは `["dpop", jkt, jti のハッシュ]` の JSON で、クライアントアサーションのキー（`[clientId, jti]`）とは要素の数が違うので重ならない。鍵ごとに分けるので、別の鍵の DPoP proof が同じ `jti` を使っても妨げない。

PR #205 から、`jti` の代わりにその SHA-256 の base64url をキーに入れるようにした。
SQL と KV のストアはキーをハッシュにしてから覚えるが、メモリのストアはキーをそのまま覚えるので、PR #205 のままでは、長い `jti` の DPoP proof を送ってその長さだけメモリを使わせることができた（RFC 9449 §11.1 がメモリを使い果たさせる攻撃として挙げるもの）。
ハッシュにしたので、キーの長さは `jti` の長さによらない。

## verifyDpopRequestProof, endpointUrisOf <!-- hono:oidc-provider/features/dpop/proof.ts#verifyDpopRequestProof hono:oidc-provider/features/dpop/proof.ts#endpointUrisOf nextjs:app/_oidc-provider/features/dpop/proof.ts#verifyDpopRequestProof nextjs:app/_oidc-provider/features/dpop/proof.ts#endpointUrisOf -->

リクエストの DPoP proof を、上の検査の順に確かめ、その鍵の JWK Thumbprint を返す。トークンを鍵に束縛する `cnf` の `jkt`（RFC 9449 §6.1）にする値である。
`jti` は、署名とクレームと `ath` を確かめた後で消費する。検証できない DPoP proof の `jti` を覚えると、正しいクライアントの `jti` を先に使わせる妨害ができるためである。
`htu` と比べる URI は、リクエストの URL ではなく、issuer とエンドポイントのパスから組み立てる。プロキシの後ろでも、クライアントが見る URL と比べるためである。
`iat` の範囲は、設定の `dpopProofMaxAgeSeconds` と `dpopProofLeewaySeconds` から決める（どちらかが 0 以上の有限の数でなければ `Error` を投げる。`validateDpopProofClaims` の節）。
Hono はリクエストのコンテキストの設定とストアを、Next.js は `provider.ts` の `config` と `stores` を読む。Next.js の `provider.ts` は機能の一覧を読み込むので、機能の `feature.ts` からこのモジュールを読み込むと循環するため、そのことをモジュールの先頭に書いた。
サーバーが発行する nonce（RFC 9449 §8 / §9）は確かめない。

PR #205 から、`/` で終わる issuer（`https://op.example.com/`）のときの `htu` の比べ方を直した。
PR #205 は issuer にパスをつないだ `https://op.example.com//token` とだけ比べていたが、ルートのパスは `/token` なので、エンドポイントのパスのとおりに `https://op.example.com/token` を `htu` にしたクライアントを拒否していた。
OP のメタデータも issuer にパスをつないでエンドポイントの URL を作るので、メタデータのとおりに送るクライアント（`//` を `/` にまとめるプロキシの後ろにある OP など）の `htu` は `//token` になる。そこで、そのときは両方の URI と比べる（`endpointUrisOf()`）。どちらも同じエンドポイントの URI なので、別のエンドポイントへの DPoP proof を受け付けることにはならない。`/` で終わらない issuer では、URI はこれまでどおり一つである。
テストでは、RFC 9449 §4.1 の DPoP proof が検査を通って例の JWK Thumbprint を返し、覚えた `jti` のキーと期限が期待どおりで、同じ DPoP proof の二度目を拒否することを確かめた。
`jti` を消費する位置も確かめた。署名を検証できない DPoP proof（クライアントの `jwk` を名乗り、別の鍵で署名したもの）と `ath` の合わない DPoP proof は `jti` を覚えさせず、前者の後でも、クライアント自身の同じ `jti` の DPoP proof を受け付ける。
