# @maronn-openid-connect/google-login

## 0.0.1

### Patch Changes

- a1c441f: `@maronn-openid-connect/google-login` を新設し、Sign in with Google（Google Identity Services の redirect mode）を core で組んだ OP のログイン手段として使えるようにする。Google が `login_uri` へ POST する ID トークンの検証は Google 公式の `google-auth-library`（`OAuth2Client.verifyIdToken`。公開鍵の取得とキャッシュ、署名・`aud`・`iss`・`exp` の検証）に委ね、このパッケージは `g_csrf_token` の Double Submit Cookie 検証、任意の `hd` / `email_verified` / `nonce` の確認、core の認証トランザクションへ Google ログインを束縛する nonce の発行と単回消費を提供する。ログイン画面の UI は生成せず、redirect mode に必要な `g_id_onload` の属性（`data-ux_mode="redirect"` / `data-login_uri` / `data-nonce` を必ず含む）を組み立てる `buildGoogleSignInAttributes` と、その HTML 文字列化を Node 非依存のサブパス `@maronn-openid-connect/google-login/sign-in` で提供する（プレーン HTML / React / Vue のどれからでも使える）。
  
  core と組み合わせて使う拡張パッケージであり、単体では使わない。core は experimental と同じく peerDependency（`>=0.3.0 <1.0.0`）で参照し、リリース契約（peer range の下限、core の minor / major との同時リリース）を CI で強制する対象に加えた。`google-auth-library` の要件により Node.js 22 以上限定で、エッジランタイムでは動かない。CLI の `--enable google-login`（拡張機能。既定では無効）から生成コードに組み込まれ、ログイン画面のボタンと `POST /login/google` の受け口、nonce ストア、Google ユーザーの JIT 登録が生成される（CLI 側の changeset を参照）。
  
  初回リリースは `0.0.0` から patch で `0.0.1` になる。`0.0.0` は Trusted Publisher を設定するための手動ブートストラップ用のプレースホルダーで、RELEASE.md「初回 publish（手動ブートストラップ）」に従って先に publish しておく。
