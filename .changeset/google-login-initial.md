---
"@maronn-openid-connect/google-login": patch
---

`@maronn-openid-connect/google-login` を新設し、Sign in with Google（Google Identity Services の redirect mode）を core で組んだ OP のログイン手段として使えるようにする。Google が `login_uri` へ POST する ID トークンの検証は Google 公式の `google-auth-library`（`OAuth2Client.verifyIdToken`。公開鍵の取得とキャッシュ、署名・`aud`・`iss`・`exp` の検証）に委ね、このパッケージは `g_csrf_token` の Double Submit Cookie 検証、任意の `hd` / `email_verified` / `nonce` の確認、ログイン画面に埋め込む「Google でログイン」ボタンの HTML 生成、core の認証トランザクションへ Google ログインを束縛する nonce の発行と単回消費を提供する。

core と組み合わせて使う拡張パッケージであり、単体では使わない。core は experimental と同じく peerDependency（`>=0.3.0 <1.0.0`）で参照し、リリース契約（peer range の下限、core の minor / major との同時リリース）を CI で強制する対象に加えた。`google-auth-library` の要件により Node.js 22 以上限定で、エッジランタイムでは動かない。CLI（`--enable google-login`）への組み込みはこのリリースには含まれず、生成コードへの配線は README の手順に従って手で行う。

初回リリースは `0.0.0` から patch で `0.0.1` になる。`0.0.0` は Trusted Publisher を設定するための手動ブートストラップ用のプレースホルダーで、RELEASE.md「初回 publish（手動ブートストラップ）」に従って先に publish しておく。
