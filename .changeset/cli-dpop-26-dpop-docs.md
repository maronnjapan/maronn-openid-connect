---
'@maronn-openid-connect/cli': patch
---

CLI の README の拡張機能 `dpop` の説明に、生成する `features/dpop/`（Next.js は `_oidc-provider/features/dpop/`）のファイルの一覧と、設定で変えられない方針（受け付ける alg と鍵の形、`htu` の比べ方、束縛の規則、nonce の形、エラーの応答など）を直す場所と、DPoP（拡張）のガイドへの案内を足した。

`--db sql` の `client_assertion_jtis` テーブルと、`--db kv` の `client_assertion_jti:<hash>` のキーの説明に、`dpop` を有効にすると、受け付けた DPoP proof（鍵と `jti` から作ったハッシュ）もその DPoP proof を受け付ける最後の秒まで入ることを書いた。これまでの生成物も同じ動きで、説明が足りなかった。

生成されるコードと、生成した OP の動きは変わらない。
