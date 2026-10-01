---
'@maronn-openid-connect/core': patch
'@maronn-openid-connect/cli': patch
---

空文字列の `client_secret` を「未提示」として扱う（RFC 6749 §3.2）

`extractClientCredentials` が値なしのフォームフィールド（`client_secret=`）を client_secret_post の資格情報として数えていたため、public client が `client_id=x&client_secret=` を送ると方式不一致で拒否され、`Authorization: Basic` と空の `client_secret` フィールドの併存が多重認証方式として拒否されていた。RFC 6749 §3.2 の「値なしで送られたパラメータは省略として扱う（MUST）」に従い、抽出時に空文字列を未提示へ正規化する。confidential client が空の `client_secret` だけを送った場合は、従来どおり invalid_client で拒否される（拒否理由が「方式不一致」から「認証必須」になる）。CLI 生成の conformance テストにこの挙動を固定する契約テストを追加。
