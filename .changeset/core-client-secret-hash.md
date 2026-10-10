---
'@maronn-openid-connect/core': minor
'@maronn-openid-connect/experimental': patch
'@maronn-openid-connect/google-login': patch
---

client_secret をハッシュで登録できるようにし、認可コードに発行元のトランザクション ID を持たせる

- `TokenClientInfo.clientSecretHash` を追加した。client_secret の SHA-256（base64url、パディング無し）を登録すると、`verifyClientSecret()` は提示された client_secret のハッシュをこの値と定数時間で比べ、`clientSecret` は使わない。DB に client_secret を平文で置かずに済む
- 登録する値を作る `hashClientSecret()` と、照合だけを行うステップ関数 `verifyClientSecretHash()` を追加した。`verifyClientSecretHash()` は client_secret が提示されていなければ、空文字のハッシュが登録されていても通さない
- `completeAuthTransaction()` が返す `AuthorizationResponseParams` に `transactionId` を加え、`createAuthorizationCode()` / `buildAuthorizationCodeData()` はそれを `AuthorizationCodeData.transactionId` へ引き継ぐ。ストアは、どの認可リクエストから発行したコードかを記録できる。`transactionId` は認可レスポンスのパラメータではないので、リダイレクト URL には載せない

SHA-256 は速いハッシュなので、短い値や推測できる値は総当たりで元に戻される。`clientSecretHash` を使うクライアントの client_secret は、CSPRNG で作った十分長い値にすること。

experimental と google-login は core の minor リリースに合わせた同時リリースのみで、機能変更はない。
