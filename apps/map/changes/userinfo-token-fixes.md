# UserInfo のトークンの読み取りと期限の境界を直す

UserInfo エンドポイントで、仕様どおりのリクエストを拒否したり、ほかのエンドポイントと期限の判定がずれたりしていた箇所を直す。

## validateUserInfoTokenExpiration

期限の時刻ちょうど（`expiresAt === now`）のアクセストークンを期限切れとして扱うようにした（`expiresAt < now` を `expiresAt <= now` に変えた）。
これまでは同じ瞬間に、UserInfo はトークンを受け付け、イントロスペクション（`isIntrospectionTokenActive`）は inactive と答えていた。
RFC 7519 §4.1.4 の `exp` と同じく、期限の時刻からは受け付けない。
生成コードの store は期限切れのトークンを返さないが、利用者が自分で書いた resolver ではこの関数が唯一の期限の確認になる。

## parseUserInfoRequest, extractAccessToken

`Authorization: Bearer` の後ろに空白が 2 つ以上あっても、アクセストークンを読むようにした。
これまでは最初の空白より後ろをそのままトークンにしていたので、先頭に空白の残った値で照合し、invalid_token で拒否していた。
Hono はステップの関数（`parseUserInfoRequest`）、Next.js は Route Handler の補助関数（`extractAccessToken`）が、どちらも下の `readBearerToken` を呼ぶ。

## readBearerToken

`Authorization` ヘッダの値から Bearer のトークンを読む関数を足した（RFC 6750 §2.1 の `"Bearer" 1*SP b64token`）。
スキームは大文字小文字を区別せず、後ろの空白をすべて飛ばし、トークンはそのまま返す。
Bearer 以外のスキームやトークンの無い値には空文字を返し、呼び出し側は「トークンの提示なし」として 401 を返す。
Hono はステップのファイルに、Next.js は `_oidc-provider/http.ts` に置く。
