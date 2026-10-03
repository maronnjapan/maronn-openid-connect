# @maronn-openid-connect/google-login

## 0.0.3

### Patch Changes

- ed8c5a5: core 0.4.1 との同時リリース。core peer range の下限を >=0.4.1 へ更新。

## 0.0.2

### Patch Changes

- 9df8d94: introspection エンドポイントで public client の client_id 単独提示を拒否する
  
  これまで生成 OP の introspection ルートは token エンドポイントと同じクライアント認証パイプラインを使っており、`token_endpoint_auth_method: 'none'` で登録されたクライアントは「資格情報を提示していないこと」の確認だけで通過していた。public client の client_id は公開情報なので、これを認証済み呼び出し元として扱うと誰でもトークンを走査できる（RFC 7662 §2.1 は呼び出し元の認可を要求し、RFC 9701 §5 は未認証リクエストの拒否を MUST とする）。
  
  - core に導入ステップ関数 `requireConfidentialIntrospectionCaller` を追加した。登録方式が `'none'` のクライアントを `invalid_client`（401 + `WWW-Authenticate: Basic realm="Client Authentication"`）で拒否し、それ以外（既定の `client_secret_basic` を含む）は通す
  - CLI が生成する introspection ルートは、クライアント認証パイプラインの直後・トークン解決の前にこのステップを呼ぶ。`--enable jwt-introspection-response` の JWT 経路もこの拒否より後にあるため、Accept ヘッダーで迂回できない
  - revocation ルートは変更していない（RFC 7009 §2.1 は public client が自分のトークンを失効させることを正当に許す）
  
  experimental と google-login は core の minor リリースに合わせた同時リリースのみで、機能変更はない。

## 0.0.1

### Patch Changes

- a1c441f: `@maronn-openid-connect/google-login` を新設し、Sign in with Google（Google Identity Services の redirect mode）を core で組んだ OP のログイン手段として使えるようにする。Google が `login_uri` へ POST する ID トークンの検証は Google 公式の `google-auth-library`（`OAuth2Client.verifyIdToken`。公開鍵の取得とキャッシュ、署名・`aud`・`iss`・`exp` の検証）に委ね、このパッケージは `g_csrf_token` の Double Submit Cookie 検証、任意の `hd` / `email_verified` / `nonce` の確認、core の認証トランザクションへ Google ログインを束縛する nonce の発行と単回消費を提供する。ログイン画面の UI は生成せず、redirect mode に必要な `g_id_onload` の属性（`data-ux_mode="redirect"` / `data-login_uri` / `data-nonce` を必ず含む）を組み立てる `buildGoogleSignInAttributes` と、その HTML 文字列化を Node 非依存のサブパス `@maronn-openid-connect/google-login/sign-in` で提供する（プレーン HTML / React / Vue のどれからでも使える）。
  
  core と組み合わせて使う拡張パッケージであり、単体では使わない。core は experimental と同じく peerDependency（`>=0.3.0 <1.0.0`）で参照し、リリース契約（peer range の下限、core の minor / major との同時リリース）を CI で強制する対象に加えた。`google-auth-library` の要件により Node.js 22 以上限定で、エッジランタイムでは動かない。CLI の `--enable google-login`（拡張機能。既定では無効）から生成コードに組み込まれ、ログイン画面のボタンと `POST /login/google` の受け口、nonce ストア、Google ユーザーの JIT 登録が生成される（CLI 側の changeset を参照）。
  
  初回リリースは `0.0.0` から patch で `0.0.1` になる。`0.0.0` は Trusted Publisher を設定するための手動ブートストラップ用のプレースホルダーで、RELEASE.md「初回 publish（手動ブートストラップ）」に従って先に publish しておく。
