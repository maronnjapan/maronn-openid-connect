---
'@maronn-openid-connect/cli': patch
---

`--enable dynamic-client-registration` が生成する登録エンドポイントを堅牢化する

- 発行した `client_secret` をストアにはハッシュ（core の `hashClientSecret`）で保存する。201 応答は従来どおり平文を一度だけ返し、トークンエンドポイントの認証は静的クライアントと同じハッシュ照合（timing-safe）になる
- 総数上限（`maxRegisteredClients`）を保存後に再検査し、並行リクエストが同時に検査を通過しても上限を超えない。ストア契約に `delete(clientId)` が加わるため、永続実装へ差し替えている場合は実装を足す
- 上限超過を宣言する `Content-Length` はボディを読む前に 400 で拒否する（本検査は従来どおりボディの UTF-8 バイト数）
- Next.js の生成ルートで、転送中断時にも固定の `server_error` JSON と `Cache-Control: no-store` が返るよう、ボディ読み取りを try の中へ移す
- `redirect_uris` の固定エラー文言を実際の検査規則（カスタムスキームは通る）に合わせ、`client_name` では C1 制御文字、bidi 制御文字、ゼロ幅文字も拒否する
