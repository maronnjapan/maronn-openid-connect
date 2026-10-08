---
"@maronn-openid-connect/core": minor
"@maronn-openid-connect/cli": minor
"@maronn-openid-connect/experimental": patch
"@maronn-openid-connect/google-login": patch
---

同意画面にクライアント識別情報（client_name / client_uri / policy_uri / tos_uri）を表示できるようにする

OIDC Dynamic Client Registration 1.0 §2 / RFC 7591 §2 が定義する表示用クライアントメタデータを `ClientInfo` に追加し、生成 OP の同意画面が登録済みの `client_name` を `client_id` に併記して表示する。`client_uri` / `policy_uri` / `tos_uri` はリンクとして描画する。RFC 6749 §10.2 のクライアントなりすまし防御は、エンドユーザーがクライアントを識別できて初めて機能するため、内部識別子しか出なかった既定画面を判断できる画面にする。

- core: `ClientInfo` に `clientName` / `clientUri` / `logoUri` / `policyUri` / `tosUri` を OPTIONAL で追加し、表示用 URI を http / https のアロウリストで判定する `isSafeDisplayUri()` を公開する
- cli: 生成される `routes/consent.ts`（Next.js は `consent/page.tsx`）の GET 経路が `clientResolver.findClient()` で表示用メタデータを解決し、スキーム検査を通った URI だけをビューへ渡す。クライアント未解決や resolver 失敗時は従来どおり `client_id` のみで描画する
- 既定ビューは `logo_uri` を受け取っても描画しない。クライアントが選んだ URL の `<img>` を既定で出すと、ロゴ詐称によるフィッシング面・CSP img-src の拡大・閲覧ごとの第三者へのエンドユーザー IP 送出が開くため、自前ビュー（`createViews()` / Next.js のページ編集）で明示的に選択させる
- sample の `example-client` に `clientName` / `policyUri` / `tosUri` の例を追加
