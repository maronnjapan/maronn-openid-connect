# Rich Authorization Requests（RFC 9396）を experimental 機能として追加する

`--enable rar` で生成コードに入る experimental 機能として、`authorization_details` パラメータの検証・同意表示・保持と、トークン応答・introspection への反映を追加する。
型（`type`）の意味解釈は OP 運用者が `rarTypes` として注入する型定義に委ね、experimental パッケージは構造検証と配管だけを持つ。
base への変更は、rar 無効時の生成物の挙動を変えないもの（`let` 化、所有ブロックの挿入点、optional な表示項目、同意画面のフック）に限る。

## introspection <!-- endpoint:introspection -->

<!-- 自動要約: `describeIntrospectedToken()` の呼び出し: `const` を `let` に変えた / ステップ「authorization details を introspection 応答へ含める」 を足した -->
<!-- 届く先: hono:introspection -->
RFC 9396 §9.2 は `active: true` の応答に `authorization_details` を top-level member で載せることを求める。署名（jwt-introspection-response）より前に member を足すため、`[build-response]` の直後に rar のブロックを置き、応答の変数を `let` にした。rar 無効時はブロックごと消え、従来の `const` 相当の流れに戻る。

## token <!-- endpoint:token -->

<!-- 自動要約: ステップ「トークンリクエストの authorization_details を拒否する」 を足した / `buildTokenResponse()` の呼び出し: `const` を `let` に変えた / ステップ「承認済みの authorization details を応答へ含める」 を足した -->
<!-- 届く先: hono:token -->
RFC 9396 §6 の再指定（narrowing）は非対応なので、黙殺せず `invalid_authorization_details` で明示拒否する。拒否はトークン発行・保存・ローテーション失効のすべてに先行させる必要があり、dispatch 群の直後・`[validate-grant-type]` の前に置いた。応答側は §7 の MUST（承認済み details を応答へ含める）のために `[build-token-response]` の直後で応答を差し替えるので、`const` を `let` にした。

## assertAuthorizationDetailShape <!-- experimental:rar/authorization-details.ts#assertAuthorizationDetailShape -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:authorize, nextjs:authorize -->
RFC 9396 §2 の type REQUIRED と §2.2 の共通フィールドの型を 1 要素ずつ fail-closed に検査する。エラー文言は固定 ASCII で、入力値（金額・口座・type 名）を反映しない（§13）。

## describeAuthorizationDetails <!-- experimental:rar/authorization-details.ts#describeAuthorizationDetails -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:consent -->
同意画面の表示行を型定義の `describe` から組み立てる。対応する型定義の無い要素は黙って落とさず例外にする。表示されない権限が承認されるのを防ぐためである（§3.1 の merged set の MUST）。

## measureParsedInput <!-- experimental:rar/authorization-details.ts#measureParsedInput -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:authorize, nextjs:authorize -->
Request Object 経由の値はパース済み JSON で届くため、`JSON.stringify` した文字列でバイト長上限を測る。stringify できない値はこの時点で拒否する。

## parseAuthorizationDetailsInput <!-- experimental:rar/authorization-details.ts#parseAuthorizationDetailsInput -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:authorize, nextjs:authorize -->
クエリ / PAR 経由の文字列と Request Object 経由のパース済み値の違いを入口で吸収する（仕様タスクの U3 の確定）。バイト長 → 配列 → 要素数 → 要素の形の順で、どの違反も `RarError` の固定文言で拒否する。

## parseFromString <!-- experimental:rar/authorization-details.ts#parseFromString -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:authorize, nextjs:authorize -->
生文字列の UTF-8 バイト長を JSON.parse の前に検査し、巨大な JSON のパース自体を入口で止める（DoS 対策。§11.4 は長大なリクエストに PAR を示唆）。

## validateAuthorizationDetails <!-- experimental:rar/authorization-details.ts#validateAuthorizationDetails -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:authorize, nextjs:authorize -->
RFC 9396 §5 の「理解しない type を含むリクエストは拒否しなければならない」の実装。型定義が空なら全拒否（fail-closed）で、型定義の `validate` が投げた例外は握りつぶさない。

## createInMemoryRarDetailsStore <!-- experimental:rar/store.ts#createInMemoryRarDetailsStore -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: nextjs:authorize, nextjs:consent, nextjs:token, nextjs:introspection -->
承認前（transactionId）と承認後（grantId）の details を持つ in-memory ストア。書き込み時の lazy eviction は ciba のストアの先例に合わせた。本番では永続ストアへ差し替える前提の動作確認用である。

## processAuthorizationRequest <!-- hono:oidc-provider/endpoints/authorize/pipeline.ts#processAuthorizationRequest -->

<!-- 自動要約: ステップ「authorization_details を検証し、同意を必須にする」 を足した / ステップ「authorization details をトランザクションへ保持する」 を足した -->
<!-- 届く先: hono:authorize -->
rar の 2 ブロックを挿入した。検証は `[validate-request]` 群の後・`[create-transaction]` の前（prompt への `consent` 付与をトランザクションに保存させるため）、保持はトランザクション ID が決まった直後に置く。

## prepareConsent <!-- hono:oidc-provider/endpoints/consent/pipeline.ts#prepareConsent -->

<!-- 自動要約: `describeConsentScreen()` の呼び出し を足した / `return describeConsentScreen(c, transactionId, tr…` を消した / ステップ「同意画面に authorization details の表示行を加える」 を足した -->
<!-- 届く先: hono:consent -->
`return describeConsentScreen(...)` を `let screen` と `return` に分け、rar の所有ブロックの挿入点を作った。rar 無効時の挙動は変わらない。

## submitConsent <!-- hono:oidc-provider/endpoints/consent/pipeline.ts#submitConsent -->

<!-- 自動要約: ステップ「承認された authorization details をグラントへ紐付ける」 を足した -->
<!-- 届く先: hono:consent -->
承認の確定点（`[issue-authorization-code]` の直後）で details を grantId に付け替える rar のブロックを挿入した。承認より前に grant へ紐付けないため、この位置である。

## appendAuthorizationDetailsToIntrospection <!-- hono:oidc-provider/features/rar/steps/append-introspection-details.ts#appendAuthorizationDetailsToIntrospection -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:introspection -->
RFC 9396 §9.2 の MUST（top-level member）。`active: false` の応答と details の無いグラントの応答は一切変えず、資源サーバー別のフィルタリングはしない（v1 の割り切り。Docs の既知の制約に記載）。

## appendAuthorizationDetailsToTokenResponse <!-- hono:oidc-provider/features/rar/steps/append-token-response-details.ts#appendAuthorizationDetailsToTokenResponse -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:token -->
RFC 9396 §7 の MUST。承認された配列をそのまま返し、§7.1 の enrichment はしない。grantId は authorization_code / refresh_token 両グラントを貫通するので、refresh でも同じ details が返る。

## describeTransactionAuthorizationDetails <!-- hono:oidc-provider/features/rar/steps/describe-authorization-details.ts#describeTransactionAuthorizationDetails -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:consent -->
同意画面に details の表示行を併記する（§3.1）。行はプレーン文字列で、エスケープは view 層（JSX）に委ねる。型定義が消えていたら例外にして、表示できない権限の承認を止める。

## recordAuthorizationDetails <!-- hono:oidc-provider/features/rar/steps/record-authorization-details.ts#recordAuthorizationDetails -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:authorize -->
検証済み details をトランザクションと同じ寿命で保持する。同意まで進まなかったトランザクションの details を失効で確実に消すため、TTL を揃えた。

## recordGrantedAuthorizationDetails <!-- hono:oidc-provider/features/rar/steps/record-granted-details.ts#recordGrantedAuthorizationDetails -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:consent -->
承認された details を grantId に付け替え、transactionId 側は削除する。寿命は `refreshTokenAbsoluteLifetime` 起点で、ローテーションが絶対寿命を固定するため、有効なリフレッシュトークンより先に details が消えることはない（§7 の MUST の保持側）。

## rejectTokenRequestAuthorizationDetails <!-- hono:oidc-provider/features/rar/steps/reject-token-request-details.ts#rejectTokenRequestAuthorizationDetails -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:token -->
トークンリクエストの `authorization_details` は黙殺せず 400 で明示拒否する（narrowing されたとクライアントに誤認させないため）。副作用（発行・保存・失効）より前のステップに置くことが要件である。

## validateAuthorizationDetailsRequest <!-- hono:oidc-provider/features/rar/steps/validate-authorization-details.ts#validateAuthorizationDetailsRequest -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:authorize -->
Request Object 優先（OIDC Core §6.1）で値を読み、構造・上限・型定義を検査する。details は毎回同意が要るため `prompt=none` 単独は `consent_required`、それ以外は `prompt` に `consent` を足して silent / SSO の同意スキップを塞ぐ。`none` と他値の不正な組み合わせには手を出さず、base の検査に委ねる。

## introspect <!-- nextjs:app/(introspection)/introspect/route.ts#introspect -->

<!-- 自動要約: ステップ「authorization details を introspection 応答へ含める」 を足した -->
<!-- 届く先: nextjs:introspection -->
hono の introspection パイプラインと同じ位置（`[build-response]` の後、`[respond-jwt]` の前）に rar のブロックを挿入した。応答の変数は元から `let` なので base 変更は不要だった。

## recordAuthorizationDetails <!-- nextjs:app/_oidc-provider/features/rar/authorize.ts#recordAuthorizationDetails -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: nextjs:authorize -->
hono の同名ステップと同じ契約。トランザクションの TTL と同じ寿命で保持する。

## validateAuthorizationDetailsRequest <!-- nextjs:app/_oidc-provider/features/rar/authorize.ts#validateAuthorizationDetailsRequest -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: nextjs:authorize -->
hono の同名ステップと同じ検証と prompt 制御。Route Handler では `prompt` を書き換える対象の `validatedRequest` がまだ無いので、更新後の prompt を戻り値で返す形にした。

## resolveRarTypes <!-- nextjs:app/_oidc-provider/features/rar/config.ts#resolveRarTypes -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: nextjs:authorize -->
Next.js はモジュールを層ごとに読み込むため、instrumentation（dev-data）から `config.rarTypes` へ代入しても Route Handler へ届かない。`config.rarTypes` を優先しつつ、起動フック用の注入口として shared() の `rarConfig.types` をフォールバックにした。

## recordGrantedAuthorizationDetails <!-- nextjs:app/_oidc-provider/features/rar/consent.ts#recordGrantedAuthorizationDetails -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: nextjs:consent -->
hono の同名ステップと同じ契約。寿命は呼び出し元が `config.refreshTokenAbsoluteLifetime` で渡す。

## appendAuthorizationDetailsToIntrospection <!-- nextjs:app/_oidc-provider/features/rar/introspect.ts#appendAuthorizationDetailsToIntrospection -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: nextjs:introspection -->
hono の同名ステップと同じ契約（§9.2 の top-level member、inactive 不変）。

## appendAuthorizationDetailsToTokenResponse <!-- nextjs:app/_oidc-provider/features/rar/token.ts#appendAuthorizationDetailsToTokenResponse -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: nextjs:token -->
hono の同名ステップと同じ契約（§7 の MUST、enrichment なし）。Route Handler のボディ型を保つためジェネリックにした。

## rejectTokenRequestAuthorizationDetails <!-- nextjs:app/_oidc-provider/features/rar/token.ts#rejectTokenRequestAuthorizationDetails -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: nextjs:token -->
hono の同名ステップと同じ契約。Route Handler は例外でなく `Response` を返す流儀なので、拒否応答を返すか `null` を返す形にした。

## authorize <!-- nextjs:app/authorize/route.ts#authorize -->

<!-- 自動要約: `validatePromptParameter()` の呼び出し: `const` を `let` に変えた / ステップ「authorization_details を検証し、同意を必須にする」 を足した / ステップ「authorization details をトランザクションへ保持する」 を足した -->
<!-- 届く先: nextjs:authorize -->
rar の 2 ブロック（検証と保持）を hono と同じ位置に挿入した。prompt への `consent` 付与をトランザクションへ保存させるため、検証はトランザクション作成の前に置く。`const prompt` は rar ブロックが差し替えられるよう `let` にした（無効時の挙動は不変）。

## POST <!-- nextjs:app/consent/decision/route.ts#POST -->

<!-- 自動要約: ステップ「承認された authorization details をグラントへ紐付ける」 を足した -->
<!-- 届く先: nextjs:consent -->
承認の確定点（認可コードの発行直後）で details を grantId に付け替える rar のブロックを挿入した。

## token <!-- nextjs:app/token/route.ts#token -->

<!-- 自動要約: ステップ「トークンリクエストの authorization_details を拒否する」 を足した / 処理 `let tokenResponse = { access_token, token_type, e…`: `const` を `let` に変えた / ステップ「承認済みの authorization details を応答へ含める」 を足した -->
<!-- 届く先: nextjs:token -->
hono の token パイプラインと同じ 2 箇所（dispatch 群の直後の拒否、応答組み立て直後の反映）に rar のブロックを挿入し、`const tokenResponse` を `let` にした。

## defaultConsentPage <!-- hono:oidc-provider/views.tsx#defaultConsentPage -->

<!-- 自動要約: `return (<Layout title="Consent"> <h1>Authorize Ap…`: 式を書き換えた -->
<!-- 届く先: なし -->
同意画面に optional の `authorizationDetails` を併記する。無ければ描画も変わらないので、rar 無効時の画面は従来どおりである。

## consentRowsOf <!-- nextjs:app/_oidc-provider/feature.ts#consentRowsOf -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: なし -->
Next.js の consent は Route Handler でなくページなので、所有ブロックを置けない。loginMethods と同じ「機能のフック」を consent にも作り、ページは有効な機能の行を並べるだけにした。rar 無効時は features に rar が無く、空配列になる。

## describeTransactionAuthorizationDetails <!-- nextjs:app/_oidc-provider/features/rar/consent.ts#describeTransactionAuthorizationDetails -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: なし -->
consent フックの実装。details の無いトランザクションでは空配列を返し、型定義が消えていたら例外にする（hono の describe ステップと同じ判断）。
