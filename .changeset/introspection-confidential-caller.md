---
"@maronn-openid-connect/core": minor
"@maronn-openid-connect/cli": minor
"@maronn-openid-connect/experimental": patch
"@maronn-openid-connect/google-login": patch
---

introspection エンドポイントで public client の client_id 単独提示を拒否する

これまで生成 OP の introspection ルートは token エンドポイントと同じクライアント認証パイプラインを使っており、`token_endpoint_auth_method: 'none'` で登録されたクライアントは「資格情報を提示していないこと」の確認だけで通過していた。public client の client_id は公開情報なので、これを認証済み呼び出し元として扱うと誰でもトークンを走査できる（RFC 7662 §2.1 は呼び出し元の認可を要求し、RFC 9701 §5 は未認証リクエストの拒否を MUST とする）。

- core に導入ステップ関数 `requireConfidentialIntrospectionCaller` を追加した。登録方式が `'none'` のクライアントを `invalid_client`（401 + `WWW-Authenticate: Basic realm="Client Authentication"`）で拒否し、それ以外（既定の `client_secret_basic` を含む）は通す
- CLI が生成する introspection ルートは、クライアント認証パイプラインの直後・トークン解決の前にこのステップを呼ぶ。`--enable jwt-introspection-response` の JWT 経路もこの拒否より後にあるため、Accept ヘッダーで迂回できない
- revocation ルートは変更していない（RFC 7009 §2.1 は public client が自分のトークンを失効させることを正当に許す）

experimental と google-login は core の minor リリースに合わせた同時リリースのみで、機能変更はない。
