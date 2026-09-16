---
"@maronn-openid-connect/google-login": patch
---

`@maronn-openid-connect/google-login` を新設し、Sign in with Google（Google Identity Services の redirect mode）を core で組んだ OP のログイン手段として使えるようにする。Google が `login_uri` へ POST する ID トークンの検証（Google の公開鍵による署名検証、`aud` / `iss` / `exp` の確認、任意の `hd` と `email_verified` の確認）、`g_csrf_token` の Double Submit Cookie 検証、ログイン画面に埋め込む「Google でログイン」ボタンの HTML 生成、core の認証トランザクションへ Google ログインを束縛する nonce の発行と単回消費を提供する。Google の公開鍵（JWK Set）は `Cache-Control: max-age` に従ってキャッシュし、未知の `kid` では間隔を空けて取り直す。

core と組み合わせて使う拡張パッケージであり、単体では使わない。core は experimental と同じく peerDependency（`>=0.3.0 <1.0.0`）で参照し、リリース契約（peer range の下限、core の minor / major との同時リリース）を CI で強制する対象に加えた。CLI（`--enable google-login`）への組み込みはこのリリースには含まれず、生成コードへの配線は README の手順に従って手で行う。

初回リリースは `0.0.0` から patch で `0.0.1` になる。`0.0.0` は Trusted Publisher を設定するための手動ブートストラップ用のプレースホルダーで、RELEASE.md「初回 publish（手動ブートストラップ）」に従って先に publish しておく。
