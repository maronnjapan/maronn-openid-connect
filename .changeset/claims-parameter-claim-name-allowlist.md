---
"@maronn-openid-connect/core": minor
"@maronn-openid-connect/cli": minor
---

`claims` パラメータで読み出せるクレーム名にアロウリストを導入しました。

これまで `applyRequestedClaims` は `claims.userinfo` のキー名を、そのまま `UserClaimsResolver.findUserClaims()` が返したオブジェクトのプロパティ名として読み出していました。キー名は RP が任意に指定できるため、DB の行オブジェクトや内部ユーザーモデルをそのまま返す resolver 実装（PoC で最も自然な書き方）では、`claims={"userinfo":{"password_hash":null}}` のようなリクエスト 1 本で、scope とは無関係に内部フィールドが UserInfo レスポンスから返っていました。`UserClaims` は閉じた interface ですが、TypeScript の構造的部分型では変数経由の余剰プロパティは検査されないため、型は実行時の防御になっていません。

変更点:

- `applyRequestedClaims` に第 4 引数 `allowedClaimNames: ReadonlySet<string>` を追加しました。既定値は新しくエクスポートした `DEFAULT_REQUESTABLE_CLAIMS`（`sub` ＋ `SCOPE_CLAIMS_MAP` の全クレーム）です
- `applyRequestedClaims` に `hasOwnProperty` 検査を追加し、プロトタイプチェーン由来のプロパティ（クラスインスタンスの getter など）を読まないようにしました
- `handleUserInfoRequest` の `UserInfoRequestContext` に `allowedClaimNames?: ReadonlySet<string>` を追加しました
- `UserClaimsResolver.findUserClaims` の JSDoc に「戻り値は外部へ開示されうる面である」契約を追記しました（`study-material/resolver-and-store-contract.md` にも同契約を追加）
- 生成される `conformance.test.ts` に、余剰フィールドを返す resolver を注入して開示されないことを固定する契約テストを追加しました（hono / express / fastify / nextjs）

アロウリスト外のクレーム名を要求されても、エラーにはせず黙って返しません。OIDC Core 1.0 §5.5.1 は、要求クレームを返せない場合に OP がエラーを返してはならない（MUST NOT）と定めており、`essential: true` についても best effort（SHOULD）であるため、返さないことは常に仕様適合です。

移行上の注意:

- 既定のアロウリストは scope 経由で既に返りうるクレームと同一集合です。標準クレームは従来どおり `claims` 経由で返るため、**標準クレームだけを扱っている限り挙動は変わりません**
- 非標準クレームを `claims` 経由で返していた場合は返らなくなります。OP の語彙を `handleUserInfoRequest({ allowedClaimNames })`（生成 OP のようにステップ関数を直接呼ぶ場合は `applyRequestedClaims` の第 4 引数）へ注入してください。語彙は OIDC Discovery 1.0 §3 の `claims_supported` として公開する対象と一致させること
- resolver がクラスインスタンスを返し、クレームをプロトタイプの getter で公開している場合、そのクレームは `claims` 経由で返らなくなります。`findUserClaims` は開示してよいクレームを戻り値自身の own property として載せて返してください
