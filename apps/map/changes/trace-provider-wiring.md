# 配線の振る舞いをエンドポイントから読める形にする

値の型が分かることと、その値を作った処理まで辿れることは別である。`jwks_uri` の wrapper を題材に、処理の構築を初期化の陰へ隠さず、型付き helper をエンドポイントから呼ぶ方針に揃える。

同じ切れ目を持つ認証、検証鍵の既定処理、callback contract も整理する。動的な hook や middleware の実行先は推測せず、解析できない理由を地図に残す。設計比較と出力の証拠は docs/design-traceable-wiring.md と docs/wiring-audit/ に置く。

## resolveRequestObjectParams <!-- core:authorization-request.ts#resolveRequestObjectParams -->

鍵の読込みを受け渡す契約に名前を与え、型のメンバーと実装の接続が途中で失われないようにする。署名アルゴリズムを検査してから鍵を読む順序は保つ。

## withClientJwksUriKeys <!-- core:client-jwks-uri.ts#withClientJwksUriKeys -->

鍵の検索と取得を型付きの契約として保持する。wrapper を作る時点と、返した resolver が鍵を読む時点を地図が区別できるようにする。

## getClientKeyResolver <!-- hono:oidc-provider/client-jwks-uri.ts#getClientKeyResolver -->

初期化やコンテキストへの上書きを追わなければ振る舞いが分からない形を避ける。呼び出した時点の設定と、機能が追加したクライアントを使い、キャッシュの共有は維持する。

## verifyIdTokenHint <!-- hono:oidc-provider/endpoints/authorize/steps/verify-id-token-hint.ts#verifyIdTokenHint -->

既定の検証鍵を作る処理を匿名のコンテキスト関数に隠さない。利用者が指定する JWKS の選択肢は残す。

## authenticateEndUser <!-- hono:oidc-provider/endpoints/login/steps/authenticate-user.ts#authenticateEndUser -->

既定の認証処理を任意の関数値に見せず、ストレージの型付き契約として読む。カスタムストレージによる差替えは引き続き認証の契約を満たす。

## handler <!-- hono:oidc-provider/endpoints/userinfo/pipeline.ts#handler -->

処理本体の識別を変数の関数値へ依存させず、通常の関数と同じカタログの規則で維持する。

## submitCibaLogin <!-- hono:oidc-provider/features/ciba/endpoints/ciba/steps/submit-login.ts#submitCibaLogin -->

パスワード認証の配線を通常のログインと同じ型付きストレージの契約に揃える。機能ごとの匿名 callback の差異を増やさない。

## submitDeviceLogin <!-- hono:oidc-provider/features/device-authorization-grant/endpoints/device/steps/submit-login.ts#submitDeviceLogin -->

デバイスのログインも、通常のログインと同じ型付き認証の契約に揃える。機能削除の境界を保ちながら配線を読めるようにする。

## issueIdJag <!-- hono:oidc-provider/features/id-jag/steps/dispatch-id-jag-issuance.ts#issueIdJag -->

ID Token の検証鍵を選ぶ理由を共通の helper へ集め、コンテキストが既定の closure を持つという暗黙の前提を取り除く。

## resolveRequestObject <!-- hono:oidc-provider/features/request-object/steps/resolve-request-object.ts#resolveRequestObject -->

クライアントの鍵を使う処理自身が `jwks_uri` 対応を明示的に選ぶ。middleware やモジュールの評価順を知らなくても、準備から core の契約まで辿れるようにする。

## processEndSessionRequest <!-- hono:oidc-provider/features/rp-initiated-logout/endpoints/logout/steps/process-end-session-request.ts#processEndSessionRequest -->

ログアウトでも ID Token の検証鍵を共通の契約から選ぶ。別のエンドポイントにだけ既定の振る舞いが隠れる状態を作らない。

## idTokenHintJwks <!-- hono:oidc-provider/id-token-hint-jwks.ts#idTokenHintJwks -->

既定の振る舞いと外部 callback の差替えの境界を一か所へ集める。地図が読める関数として既定の鍵変換を保持する。

## withRegisteredClientJwksUri <!-- nextjs:app/_oidc-provider/client-jwks-uri.ts#withRegisteredClientJwksUri -->

中間の object を作った時点でも callback の契約を失わないようにする。後で spread する形でも型と実装の橋を保ち、Hono と同じ解析を使えるようにする。

## resolveRequestObject <!-- nextjs:app/_oidc-provider/features/request-object/authorize.ts#resolveRequestObject -->

クライアントの鍵を使う処理自身が `jwks_uri` 対応を明示的に選ぶ。middleware やモジュールの評価順を知らなくても、準備から core の契約まで辿れるようにする。

## getClientKeyResolver <!-- nextjs:app/_oidc-provider/provider.ts#getClientKeyResolver -->

初期化やコンテキストへの上書きを追わなければ振る舞いが分からない形を避ける。呼び出した時点の設定と、機能が追加したクライアントを使い、キャッシュの共有は維持する。

## defaultIsOfflineAccessGranted <!-- core:authorization-request.ts#defaultIsOfflineAccessGranted -->

公開された既定の振る舞いも通常の関数カタログに含める。既存 callback の戻り値型を維持して、型の互換性を不要に狭めない。

## setRequestContext <!-- hono:oidc-provider/app.ts#setRequestContext -->

コンテキストへは元の adapter と選択用の設定を置き、既定の振る舞いを構築する場所にしない。値を読むだけのコードから見えない上書きを減らす。

## handleAuthorizationRequest <!-- hono:oidc-provider/endpoints/authorize/page.ts#handleAuthorizationRequest -->

関数値に隠れた本体を通常の関数宣言へ揃える。エンドポイントと共有 helper の識別規則を分けない。

## withDynamicallyRegisteredClients <!-- hono:oidc-provider/features/dynamic-client-registration/store.ts#withDynamicallyRegisteredClients -->

汎用の匿名メソッド制約ではなく、実際に受け付けるクライアント検索の契約を型で表す。機能が resolver を広げる際も元の interface を失わないようにする。

## defaultIdJagActorTokenResolver <!-- hono:oidc-provider/features/id-jag/config.ts#defaultIdJagActorTokenResolver -->

既定の actor 検証も名前付きの関数として保持する。設定の関数値という理由で本体がカタログから消えることを避ける。

## createStoreResolvers <!-- hono:oidc-provider/resolvers.ts#createStoreResolvers -->

同意の失効から呼ぶ業務処理を型付きの関数へ集める。任意の closure としてだけ存在する処理を作らず、ストレージの差替えは引き続き許す。

## revokeConsentAndTokens <!-- hono:oidc-provider/resolvers.ts#revokeConsentAndTokens -->

同意と関連トークンを失効させる判断を一か所に保ち、resolver の構築と後で実行される処理を混同しないようにする。

## withDynamicallyRegisteredClients <!-- nextjs:app/_oidc-provider/features/dynamic-client-registration/store.ts#withDynamicallyRegisteredClients -->

汎用の匿名メソッド制約ではなく、実際に受け付けるクライアント検索の契約を型で表す。機能が resolver を広げる際も元の interface を失わないようにする。

## defaultIdJagActorTokenResolver <!-- nextjs:app/_oidc-provider/features/id-jag/config.ts#defaultIdJagActorTokenResolver -->

既定の actor 検証も名前付きの関数として保持する。設定の関数値という理由で本体がカタログから消えることを避ける。

## acrResolver <!-- nextjs:app/_oidc-provider/provider.ts#acrResolver -->

生成される既定の認証コンテキスト判断も通常の関数宣言に揃える。利用者が変更する振る舞いをカタログの外に置かない。

## createStoreResolvers <!-- nextjs:app/_oidc-provider/resolvers.ts#createStoreResolvers -->

同意の失効から呼ぶ業務処理を型付きの関数へ集める。任意の closure としてだけ存在する処理を作らず、ストレージの差替えは引き続き許す。

## revokeConsentAndTokens <!-- nextjs:app/_oidc-provider/resolvers.ts#revokeConsentAndTokens -->

同意と関連トークンを失効させる判断を一か所に保ち、resolver の構築と後で実行される処理を混同しないようにする。

