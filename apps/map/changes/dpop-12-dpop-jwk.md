# DPoP の検査が使う JWK、base64url、エラーのモジュールを足す（DPoP の段 12）

DPoP（RFC 9449）を生成 OP に入れる段の 12 個目で、DPoP の機能のディレクトリ（Hono は `features/dpop/`、Next.js は `_oidc-provider/features/dpop/`）を作り、DPoP proof の検査が土台にするモジュールを足す。
`jwk.ts` は proof の `jwk` ヘッダーの公開鍵を確かめ、その鍵で JWS の署名を検証し、JWK Thumbprint を計算する。`base64url.ts` はその符号化と復号、`errors.ts` は検査の失敗（`DpopError`）、`config.ts` は受け付ける署名のアルゴリズムの設定である。
proof そのものの検査（`htm`、`htu`、`iat`、`jti`、`ath`）は次の段で足し、エンドポイントから呼ぶのはさらに後の段である。
この段ではまだどこからも読み込まないうえ、CLI の機能の一覧に `dpop` が無いので、どの生成にも入らない。生成するコードも、Hono と Next.js の OP の応答も変わらない。
PR #205 のモジュールをもとにし、そこで見つかった二つの不備（同じ鍵を複数の符号で受け付けること、検証できない alg を設定からそのまま広告する alg に入れること）を直した。
Hono と Next.js のファイルは、読み込みのパスのほかは同じ中身である。

## encodeBase64Url, decodeBase64Url <!-- hono:oidc-provider/features/dpop/base64url.ts#encodeBase64Url hono:oidc-provider/features/dpop/base64url.ts#decodeBase64Url nextjs:app/_oidc-provider/features/dpop/base64url.ts#encodeBase64Url nextjs:app/_oidc-provider/features/dpop/base64url.ts#decodeBase64Url -->

JWS の各部分と JWK の鍵のメンバー、JWK Thumbprint が使う、パディングの無い base64url（RFC 4648 §5、RFC 7515 §2）の符号化と復号である。
Hono の OP は Cloudflare Workers でも動くので、Node.js の `Buffer` を使わず、`btoa` と `atob` で書いた。

復号は、末尾の文字の余りのビットが 0 でない文字列を受け付けない（RFC 4648 §3.5 の正規の符号だけを受け付ける）。
余りのビットを見ない復号では、`Zg` と `Zh` がどちらも `f` になるように、一つのバイト列に複数の文字列が対応する。
JWK Thumbprint は鍵のメンバーの文字列をそのままハッシュにするので、そのままでは同じ鍵に複数の Thumbprint ができ、鍵への束縛の照合が符号の選び方で変わってしまう。
復号したバイト列を符号にし直し、元の文字列に戻るときだけ受け付けることで、これを防いだ。

## isDpopError <!-- hono:oidc-provider/features/dpop/errors.ts#isDpopError nextjs:app/_oidc-provider/features/dpop/errors.ts#isDpopError -->

DPoP の検査の失敗を表す `DpopError` を、`instanceof` だけでなく形（`name` が `DpopError` で、`error` が DPoP のエラーコードのどれかで、`errorDescription` が文字列であること）でも見分ける。
バンドルの都合でこのモジュールが二度読み込まれると、もう一方の `DpopError` は `instanceof` で見分けられないためである。
`error` は、どの文字列でもよいのではなく、エラーコードの一覧にあるものに限った。見分けた値の `error` は `DpopErrorCode` の型で扱われるので、一覧に無いコード（`server_error` など）を持つ値を通すと、エラーコードごとに応答を決める後の段の処理が、型の上では来ないはずのコードを受け取ってしまうためである。
`DpopError` の `error` は OAuth のエラーコードで、この段の検査が使うのは `invalid_dpop_proof`（RFC 9449 §5 / §7.1）だけなので、エラーコードの型もそれだけにした。ほかのエラーコードは、それを使う検査を足す段で加える。
`errorDescription` には検査が決めた固定の文言だけを入れ、クライアントが送った値を含めない。`error_description` に使えない文字（RFC 6749 §5.2）や、`WWW-Authenticate` の値を壊す引用符が入らないようにするためである。

## isSupportedDpopSigningAlg, profileOf, ecProfile <!-- hono:oidc-provider/features/dpop/jwk.ts#isSupportedDpopSigningAlg hono:oidc-provider/features/dpop/jwk.ts#profileOf hono:oidc-provider/features/dpop/jwk.ts#ecProfile nextjs:app/_oidc-provider/features/dpop/jwk.ts#isSupportedDpopSigningAlg nextjs:app/_oidc-provider/features/dpop/jwk.ts#profileOf nextjs:app/_oidc-provider/features/dpop/jwk.ts#ecProfile -->

DPoP proof に使える alg を、この実装が Web Crypto で検証できる非対称鍵の署名（ES256/384/512、PS256/384/512、RS256/384/512、Ed25519 の EdDSA）に限る。
RFC 9449 §4.2 / §11.6 は `none` と MAC（HS 系）を禁じ、§4.3 はアプリケーションが対応している alg だけを受け付けるとするためである。
`profileOf()` は alg ごとに、鍵の種類（`kty` と `crv`）、Web Crypto のインポートと検証のパラメータ、EC と Ed25519 の座標のバイト長、ECDSA の署名のバイト長を返す。
座標のバイト長は、P-256 が 32、P-384 が 48、P-521 が 66（RFC 7518 §6.2.1.2）、Ed25519 が 32（RFC 8032 §5.1.5）で、ECDSA の署名（`r || s`）はその 2 倍である（RFC 7518 §3.4）。

## validateDpopProofJwk, hasPublicKeyLength, rsaModulusBits, invalidJwk <!-- hono:oidc-provider/features/dpop/jwk.ts#validateDpopProofJwk hono:oidc-provider/features/dpop/jwk.ts#hasPublicKeyLength hono:oidc-provider/features/dpop/jwk.ts#rsaModulusBits hono:oidc-provider/features/dpop/jwk.ts#invalidJwk nextjs:app/_oidc-provider/features/dpop/jwk.ts#validateDpopProofJwk nextjs:app/_oidc-provider/features/dpop/jwk.ts#hasPublicKeyLength nextjs:app/_oidc-provider/features/dpop/jwk.ts#rsaModulusBits nextjs:app/_oidc-provider/features/dpop/jwk.ts#invalidJwk -->

proof の `jwk` ヘッダーが、`alg` に合う公開鍵であることを確かめる。
秘密鍵か対称鍵のメンバーを含む鍵（RFC 9449 §4.2 / §4.3）、`kty` と `crv` が `alg` に合わない鍵、2048 ビットより短い RSA の鍵（RFC 7518 §3.3 / §3.5）は、`invalid_dpop_proof` で拒否する。

PR #205 から、鍵のメンバーの符号を一つに決める検査を足した。
メンバーの base64url は正規の符号に限り（`decodeBase64Url()`）、EC の `x` と `y` は曲線の座標の長さちょうど（RFC 7518 §6.2.1.2 / §6.2.1.3）、Ed25519 の `x` は 32 バイト（RFC 8037 §2 / RFC 8032 §5.1.5）、RSA の `n` と `e` は 0 のバイトで始まらない最小のバイト数（RFC 7518 §2 の Base64urlUInt）でなければならない。
どれも、同じ公開鍵を別の文字列で表せないようにして、公開鍵の JWK Thumbprint を一つに決めるためである。
Web Crypto（Node.js で確かめた）は、先頭に 0 のバイトを足した RSA の `n` や EC の座標も、余りのビットが 0 でない符号も、同じ鍵としてインポートするので、メンバーの形はここで確かめるほかない。
短すぎる座標は Web Crypto がインポートで拒むが、そのときの失敗は署名を検証できないことになり、鍵の形の誤りと区別できない。

## computeJwkThumbprint <!-- hono:oidc-provider/features/dpop/jwk.ts#computeJwkThumbprint nextjs:app/_oidc-provider/features/dpop/jwk.ts#computeJwkThumbprint -->

公開鍵の JWK Thumbprint（RFC 7638、SHA-256）を計算する。
鍵の種類ごとの必須のメンバーだけを辞書順に並べた JSON をハッシュにするので、`kid` や `alg` のようなほかのメンバーとメンバーの順番は値を変えない。
トークンを DPoP proof の鍵に束縛するときの `cnf` の `jkt`（RFC 9449 §6.1）が、この値である。
テストでは、RFC 7638 §3.1、RFC 9449 §6.1、RFC 8037 §A.3 の例の値と一致することを確かめた。

## verifyJwsSignature <!-- hono:oidc-provider/features/dpop/jwk.ts#verifyJwsSignature nextjs:app/_oidc-provider/features/dpop/jwk.ts#verifyJwsSignature -->

`jwk` ヘッダーの公開鍵を `alg` のとおりに Web Crypto へインポートし、JWS の署名を検証する。
ECDSA の署名は JWS の形（`r || s`）のまま渡すので、曲線に合わない長さの署名（DER の署名など）は検証する前に `false` を返す。
インポートできない鍵（曲線の上に無い点など）も、例外を投げずに `false` を返す。検証できないことは、呼ぶ側が `invalid_dpop_proof` にするためである。
テストでは、RFC 9449 §4.1 の DPoP proof と RFC 8037 §A.4 の Ed25519 の JWS が検証できることと、対応するすべての alg で署名した JWS が検証できることを確かめた。

## dpopSigningAlgsOf <!-- hono:oidc-provider/features/dpop/config.ts#dpopSigningAlgsOf nextjs:app/_oidc-provider/features/dpop/config.ts#dpopSigningAlgsOf -->

設定の `dpopSigningAlgValuesSupported` のうち、この実装が検証できる alg だけを、設定の順に返す。
DPoP proof の `alg` の検査と、メタデータの `dpop_signing_alg_values_supported`（RFC 9449 §5.1）に使う値である。
PR #205 は設定をそのまま返していたので、設定に `HS256` や `ES256K` を書くと、受け付けない alg をメタデータで広告することになっていた。両者を同じこの関数の値にすることで、広告する alg と受け付ける alg が食い違わないようにした。
設定に同じ alg を二度書いたときは、最初の位置に一度だけ返す。メタデータや後の段のチャレンジの `algs` に、同じ alg が並ばないようにするためである。

設定の項目は、ほかの機能と同じく `ProviderConfig` の必須の項目として `config.ts` で宣言し、既定値（検証できるすべての alg）を `dpopConfigDefaults` に置いた。
既定値を OP の設定に重ねるのは、機能を CLI に登録する後の段（`feature.ts` の `config`）にした。この段の OP の設定には、まだこの項目が入らない。
`dpopSigningAlgsOf()` が受け取るのはこの項目だけ（`Pick<ProviderConfig, 'dpopSigningAlgValuesSupported'>`）にしたので、OP の設定を作らずに呼べる。
