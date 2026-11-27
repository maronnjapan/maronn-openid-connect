# サーバーが発行する DPoP の nonce を作って確かめるモジュールを足し、DPoP proof の検査が求められたときに nonce を確かめるようにする（DPoP の段 23）

DPoP（RFC 9449）を生成 OP に入れる段の 23 個目で、サーバーが発行する DPoP の nonce（RFC 9449 §8 / §9）の発行と検証を、DPoP の機能のディレクトリに足す（`nonce.ts`）。
nonce はサーバーに状態を持たない。発行した時刻（秒）と 12 バイトの乱数に、秘密の鍵での HMAC-SHA256 を付けたもので、MAC には発行したサーバーの役割（認可サーバーか保護されたリソースか）と issuer も入れる。
nonce を覚えるストアを足さないので、データベースのテーブルもキーも変わらず、同じ秘密を持つインスタンスはどれも互いの nonce を受け付ける。Web Crypto だけで作るので、Workers でも動く。
DPoP proof の検査（`verifyDpopRequestProof()`）は、呼び出し元が nonce を発行したサーバーの役割（`nonceServer`）を渡したときだけ、`nonce` クレームがその役割の最近の nonce であることを、`jti` を消費する前に確かめ、そうでなければ `use_dpop_nonce` で拒否する。
nonce を受け付ける期間は `ProviderConfig` の新しい項目 `dpopNonceLifetimeSeconds`（既定は 120 秒）で、秘密は Hono 系では `OidcProviderOptions.dpopNonceSecret`（dpop の機能の `context` がリクエストコンテキストの `dpopNonceSecret` に入れる）、Next.js では環境変数 `OIDC_DPOP_NONCE_SECRET` である。秘密が無ければ、プロセスごとに乱数の鍵を作る。
この段では、どのエンドポイントも `nonceServer` を渡さず、`DPoP-Nonce` ヘッダーも返さないので、OP の応答は変わらない（地図の生きた OP のケースも、すべて前と同じ状態とエラーで答える）。
nonce を求めるかどうかの設定（認可サーバーと保護されたリソースのそれぞれ）は、この段には入れず、応答で nonce を渡すエンドポイントと一緒に足す。nonce を渡す前に求める設定だけがあると、それを有効にした OP は DPoP のリクエストをすべて `use_dpop_nonce` で拒否し、クライアントには nonce を得る手段が無いためである（RFC 9449 §8 は、`use_dpop_nonce` の応答に `DPoP-Nonce` ヘッダーで nonce を付けることを求める）。
Hono と Next.js のファイルは、秘密の読み方（Hono はリクエストのコンテキスト、Next.js は環境変数）のほかは同じ中身である。

## dpopNonceKeyOf, importDpopNonceKey <!-- hono:oidc-provider/features/dpop/nonce.ts#dpopNonceKeyOf hono:oidc-provider/features/dpop/nonce.ts#importDpopNonceKey nextjs:app/_oidc-provider/features/dpop/nonce.ts#dpopNonceKeyOf nextjs:app/_oidc-provider/features/dpop/nonce.ts#importDpopNonceKey -->

nonce の MAC に使う HMAC-SHA256 の鍵を、設定した秘密から作る。
OP にはこれまで共通鍵が無く、署名鍵は非対称鍵で取り出せないこともあるので、nonce のために秘密を一つ設定してもらう形にした。
秘密は UTF-8 で 32 バイト（HMAC-SHA256 の出力の長さ、RFC 2104 §3）以上を求め、短ければ設定の誤りとして `Error` を投げる。短い鍵は MAC を弱め、推測できない nonce（RFC 9449 §8 の MUST）を保てないためである。
秘密が無いときは、プロセスで初めて呼ばれたときに 32 バイトの乱数から鍵を作って使い続ける。設定なしで一つのインスタンスを動かすときにも nonce を使えるようにするためで、別のインスタンス（Workers の別の isolate、別の Node.js のプロセス、サーバーレスの別の関数）や再起動した後のプロセスはその nonce を受け付けない。この制限は設定の JSDoc に書いた。
鍵は秘密ごとに一度だけ作り、作った鍵は取り出せない（`extractable` が `false`）。
Workers では、乱数や鍵の生成をモジュールの読み込み時に行えないので、最初に呼ばれたときに作る。

## issueDpopNonce, macInputOf <!-- hono:oidc-provider/features/dpop/nonce.ts#issueDpopNonce hono:oidc-provider/features/dpop/nonce.ts#macInputOf nextjs:app/_oidc-provider/features/dpop/nonce.ts#issueDpopNonce nextjs:app/_oidc-provider/features/dpop/nonce.ts#macInputOf -->

新しい nonce を作る。形は `<payload>.<mac>` で、`payload` は発行した時刻（8 バイトのビッグエンディアン）と 12 バイトの乱数、`mac` はその HMAC-SHA256 で、どちらもパディングのない base64url にする。
base64url の文字と `.` はどれも NQCHAR なので、nonce の構文（RFC 9449 §8.1）に合う。
乱数があるので同じ秒の nonce も毎回違い、秘密の鍵の MAC があるので、秘密を知らない者は受け付けられる nonce を作れない（RFC 9449 §8 の、nonce は推測できないこと）。
MAC の対象（`macInputOf()`）には、`DPoP-Nonce`、サーバーの役割、issuer を NUL で区切って `payload` の前に置く。認可サーバーの nonce と保護されたリソースの nonce は別のもので、発行したサーバーでだけ受け付ける（RFC 9449 §9）ためで、同じ秘密を使う別の OP の nonce も受け付けない。
nonce をエンドポイントやクライアントの鍵には結び付けない。クライアントは一つの nonce を使い続けることが期待されている（RFC 9449 §8 / §8.2）ので、エンドポイントごとに違う nonce を求めると、クライアントが nonce を取り違えるためである。
`issueDpopNonce()` は、この段ではテストだけが呼ぶ。応答に nonce を付けるエンドポイントが呼ぶ。

## verifyDpopNonce <!-- hono:oidc-provider/features/dpop/nonce.ts#verifyDpopNonce nextjs:app/_oidc-provider/features/dpop/nonce.ts#verifyDpopNonce -->

nonce が、そのサーバーが同じ鍵で最近発行したものかを返す。
MAC の比較は Web Crypto の `verify` に任せる。一致するまでの時間で正しい MAC を探られないようにするためである。
受け付けるのは、発行から `lifetimeSeconds` 秒までの nonce である。RFC 9449 §8 は、サーバーが最近発行した nonce の範囲を覚えておけばよいとしており、範囲の中の nonce は何度でも受け付ける。同じ DPoP proof の再利用は `jti` の検査が拒否し続ける（RFC 9449 §11.1）。
nonce には発行した時刻が入っているので、受け付ける期間はクライアントの時計によらない（RFC 9449 §11.1 の注）。
同じ秘密を持つほかのインスタンスの時計が少し進んでいることがあるので、5 秒先までの未来の時刻の nonce は受け付ける。
`lifetimeSeconds` が 0 以上の有限の数でなければ、`iat` の範囲と同じく設定の誤りとして `Error` を投げる。`NaN` のままでは古さの比較がどれも偽になり、`Infinity` ではどんなに古い nonce も受け付けてしまうためである。

## validateDpopProofNonce <!-- hono:oidc-provider/features/dpop/proof.ts#validateDpopProofNonce nextjs:app/_oidc-provider/features/dpop/proof.ts#validateDpopProofNonce -->

DPoP proof の `nonce` クレームが、求めたサーバーの最近の nonce であることを確かめる。
nonce を求めるサーバーは `nonce` の無い DPoP proof を受け付けない（RFC 9449 §11.3）。拒否には、新しい nonce を入れてやり直すよう求める `use_dpop_nonce`（RFC 9449 §8 / §9）を使い、DPoP の検査のエラーコードの一覧（`errors.ts`）に足した。
`nonce` が無いときの説明は RFC 9449 の例（Figure 20 / Figure 24）と同じ文にし、あっても受け付けないとき（別の役割や別の秘密の nonce、古い nonce、文字列でない値）は、それとわかる別の文にした。どちらも固定の文で、クライアントの送った値を含めない。

## verifyDpopRequestProof <!-- hono:oidc-provider/features/dpop/proof.ts#verifyDpopRequestProof nextjs:app/_oidc-provider/features/dpop/proof.ts#verifyDpopRequestProof -->

`DpopProofTarget` に、nonce を求めるエンドポイントが渡す `nonceServer`（`'authorization-server'` か `'resource-server'`）を足し、渡されたときだけ、`jti`、`htm`、`htu`、`iat` を確かめた後で nonce を確かめる。
`jti` を消費する前に確かめるのは、ほかの検査と同じく、受け付けない DPoP proof の `jti` を覚えないためである。nonce を求められたクライアントが同じ `jti` で DPoP proof を作り直しても受け付ける。
nonce の鍵は Hono 系では `OidcProviderOptions.dpopNonceSecret`（dpop の機能がリクエストコンテキストに入れる）から、Next.js では環境変数 `OIDC_DPOP_NONCE_SECRET` から作り、受け付ける期間は設定の `dpopNonceLifetimeSeconds` で決まる。現在時刻は、`iat` と nonce の検査で同じ値を使うよう一度だけ読む。
`nonceServer` が無ければ `nonce` クレームは確かめず、これまでと同じに検査する。この段ではどの呼び出し元も `nonceServer` を渡さないので、トークンエンドポイント、PAR エンドポイント、UserInfo エンドポイントの振る舞いは変わらない。
