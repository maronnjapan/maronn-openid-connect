---
"@maronn-openid-connect/experimental": patch
---

OAuth 2.0 Device Authorization Grant (RFC 8628) を `@maronn-openid-connect/experimental/device-authorization-grant` として追加しました。

ブラウザを持たない・文字入力が困難なデバイス（スマート TV / CLI ツール / IoT 機器）を、別デバイスのブラウザで認可するグラントです。`redirect_uri` が登場しないため、リダイレクト起点の攻撃面を持ちません。

- `processDeviceAuthorizationRequest`: RFC 8628 §3.1 / §3.2 のデバイス認可エンドポイント処理。`validateDeviceGrantAllowed` / `validateDeviceAuthorizationScope` / `applyOfflineAccessPolicy` / `createDeviceAuthorizationRecord` / `buildDeviceAuthorizationResponse` の合成で、ステップ関数を個別に呼べば検証の差し替え・削除ができます
- `generateUserCode` / `normalizeUserCode` / `generateUniqueUserCode`: §6.1 の base-20 文字種 `BCDFGHJKLMNPQRSTVWXZ` から 8 文字を rejection sampling（modulo bias 回避）で生成し、既存 pending レコードとの衝突を確認して再生成します
- `findPendingRecordByUserCode` / `issueVerificationBinding` / `validateVerificationBinding` / `validateVerificationCsrfToken` / `recordDeviceLoginFailure` / `approveDeviceAuthorization` / `denyDeviceAuthorization`: §3.3 の検証 UI が呼ぶステップ関数群
- `processDeviceCodeGrant` / `evaluateDeviceCodeState`: §3.5 の状態機械。`expired_token` → `slow_down`（レコードの interval を +5）→ `authorization_pending` → `access_denied` → 承認済み（atomic な `consume` による単回使用）の順で評価します。`now` を注入して期限・interval の境界をテストできます
- `DeviceAuthorizationStore`: `save` / `findByDeviceCode` / `findByUserCode` / `update` / `delete` / `consume` の 6 メソッド契約。`consume` の atomic 要件と、期限切れレコードの自主破棄の猶予を型コメントに明記しています
- `DeviceAuthorizationError` / `DeviceVerificationError`: 前者は RFC 8628 §3.5 が登録した 4 コードと RFC 6749 §5.2 の既存値のみを扱い常に 400、後者は検証 UI の 401 / 403 を表します

**ブラウザバインディングが CSRF 防御の主役です。** `user_code` はフロー開始者（＝攻撃者になり得る主体）が設計上必ず知っている識別子なので、レコード紐付きの CSRF トークンだけでは承認強要もログイン CSRF も防げません。`issueVerificationBinding` が発行する bindingSecret の生値はブラウザの HttpOnly Cookie にのみ置き、レコードには SHA-256 ハッシュだけを保存します。

依存は `@maronn-openid-connect/core` の公開 API（`generateRandomString` / `sanitizeErrorDescription`）のみで、他の Experimental 機能とはコードを共有していません。

**Experimental であり、API はマイナーリリースでも破壊的に変更されることがあります。** `scope` は必須かつ `openid` 必須（RFC 8628 §3.1 の scope 省略には非対応）、`nonce` / `prompt` / `resource` などのパラメータは受け付けず、`user_code` の総当たりに対するレート制限（§5.1）はデプロイ基盤の責務としています。
