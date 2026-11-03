---
'@maronn-openid-connect/core': patch
---

UserInfo のアクセストークンを、期限の時刻ちょうど（`expiresAt === now`）から期限切れとして扱う。`validateUserInfoTokenExpiration` はこれまで `expiresAt < now` だけを期限切れとしており、同じトークンについて、イントロスペクション（`isIntrospectionTokenActive`）とリフレッシュトークンの判定（`expiresAt <= now`）とは 1 秒ずれていた。RFC 7519 §4.1.4 の `exp` と同じ境界にそろえる。
