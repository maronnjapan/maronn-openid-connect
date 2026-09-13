---
"@maronn-openid-connect/core": minor
"@maronn-openid-connect/cli": minor
---

永続化した署名鍵を読み込む `createJwkSigningKeyProvider` と `resolveSigningKeyProvider` を core に追加し、生成コード・サンプルが起動ごとの鍵生成から固定鍵へ移行できるようにしました。

これまでサンプル OP はモジュール評価時に RSA 鍵ペアをその場で生成していました。`kid` は固定文字列なので、Cloudflare Workers の別アイソレート・Fly の別マシン・Vercel の別インスタンスがそれぞれ違う鍵を同じ `kid` で公開し、JWKS を取得したインスタンスと署名したインスタンスが食い違うと ID Token / JWT アクセストークンの検証が失敗します。RFC 7515 §4.1.4 は `kid` で検証鍵を選ぶことを、OIDC Core 1.0 §10.1 は `kid` から鍵素材への対応が OP 全体で安定していることを前提としているためです。失敗はルーティング依存で間欠的に起き、再起動・再デプロイのたびに有効期間内のトークンが検証不能になります。

追加した API:

- `createJwkSigningKeyProvider(jwk, keyId?, strengthPolicy?)`: 秘密鍵 JWK（JSON 文字列またはオブジェクト）から `SigningKeyProvider` を作ります。JSON パース・`kid` の解決と不一致検出・秘密鍵素材の有無・鍵強度（`assertKeyStrength` と同じ規則）を同期的に検証してから返すため、設定ミスは最初のトークン発行時ではなく起動時に落ちます。公開する JWK からは秘密パラメータ（`d` / `p` / `q` / `dp` / `dq` / `qi` / `oth` / `k`）を落とします
- `resolveSigningKeyProvider({ jwk, keyId, fallbackKeyId, persistenceHint, onEphemeralFallback, strengthPolicy })`: 永続鍵が設定されていればそれを、無ければプロセス単位のエフェメラル RS256 鍵を返し、後者では警告を出します

CLI の Next.js 生成物（`_oidc-provider/runtime.ts`）は `OIDC_SIGNING_KEY_JWK` / `OIDC_SIGNING_KEY_ID` を読む形に変わり、鍵生成コードは生成物から消えました。

移行上の注意:

- 既存の `SigningKeyProvider` 実装・`createCachedSigningKeyProvider` の挙動は変わりません。新 API は追加のみです
- Next.js の生成物を再生成すると `runtime.ts` に差分が出ます。`OIDC_SIGNING_KEY_JWK` を設定しない場合の挙動は従来どおり（プロセスごとの鍵）ですが、起動時に警告が出るようになります
- `OIDC_SIGNING_KEY_ID` と JWK の `kid` を両方指定して食い違っていると、起動時にエラーになります
- 永続鍵は RSA 2048bit 未満だと起動時に拒否されます（NIST SP 800-131A Rev.2）
