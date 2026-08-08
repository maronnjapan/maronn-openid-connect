---
"@maronn-openid-connect/cli": patch
---

`--enable jarm` で生成される OP が、JARM 応答 JWT を**登録鍵セットの RS256 鍵**で署名するようになりました。

これまでは汎用 `signingKeyProvider` の active key（`getSigningKey()` の戻り値）をそのまま使っていました。JARM 応答 JWT の JOSE ヘッダは常に `alg: RS256` 固定なので、active key が RS256 でない構成では Web Crypto が署名を拒否し、`response_mode=query.jwt` を要求したクライアントが認可レスポンスをまったく受け取れませんでした。

`SigningKeyProvider` は `getSigningKey()` が ES256、`getSigningKeys()` が `[RS256, ES256]` を返す実装を正式に許容しており（RS256 必須は**鍵セット**への要求です）、この構成で JARM を有効にすると認可フローが実行時に壊れていました。

- authorize ルートと consent ルートの両方で、`selectSigningKeyByAlg(signingKeys, 'RS256')` により鍵セットから RS256 鍵を選びます
- 鍵セットが未設定の生成コード（旧来の単一鍵コンテキストだけを配線した実装）は従来どおり動きます
- RS256 単一鍵構成では選択結果が active key と一致するため、生成される応答 JWT は変わりません
- 鍵セットに RS256 鍵が無い場合は、検証不能な JWT を返さず `server_error` として失敗します
- Discovery の `authorization_signing_alg_values_supported: ['RS256']` が、実際に署名へ使う鍵の alg と一致するようになりました

`--enable jarm` を付けない生成物に差分はありません。移行作業は不要です。
