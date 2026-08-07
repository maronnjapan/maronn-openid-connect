---
"@maronn-openid-connect/cli": minor
---

`--enable device-authorization-grant` を追加しました。OAuth 2.0 Device Authorization Grant（RFC 8628）を生成 OP に組み込む Experimental 機能です。

ブラウザを持たない・文字入力が困難なデバイス（スマート TV / CLI ツール / IoT 機器）が、別デバイスのブラウザでユーザーに承認してもらい、自分はトークンエンドポイントをポーリングしてトークンを受け取るフローを検証できます。

## 有効化方法

```bash
maronn-oidc generate hono --enable device-authorization-grant
pnpm add @maronn-openid-connect/core @maronn-openid-connect/experimental
```

hono / express / fastify / nextjs のすべてで生成できます。ロジックは `@maronn-openid-connect/experimental/device-authorization-grant` が提供します。

## 有効時に生成されるもの

- `routes/device-authorization.ts`: デバイス認可エンドポイント（`POST /device_authorization`）と設定値 `deviceAuthorizationConfig`（`deviceCodeExpiresIn` / `pollInterval` / `maxLoginAttempts`）
- `routes/device.ts`: 検証 UI（`GET/POST /device` / `POST /device/login` / `POST /device/approve`）
- `views.ts`: `deviceVerificationPage` / `deviceLoginPage` / `deviceApprovalPage` / `deviceCompletedPage` の 4 ページ（差し替え可能）
- `store.ts`: `InMemoryDeviceAuthorizationStore` と、ブラウザバインディング Cookie（`oidc_device_<user_code>`）のヘルパー
- `routes/token.ts`: `grant_type=urn:ietf:params:oauth:grant-type:device_code` の分岐と RFC 8628 §3.5 の状態機械（`authorization_pending` / `slow_down` / `access_denied` / `expired_token`）
- `routes/discovery.ts`: `device_authorization_endpoint` と `grant_types_supported` への URN 追加（RFC 8628 §4）
- `conformance.test.ts`: デバイスフローの契約テスト

## 移行上の注意

- **既定は無効です。** `--enable` を付けずに生成した OP の出力と挙動は従来どおりで、変更はありません（`conformance.test.ts` にのみ「機能が無効であること」を固定する契約テストが追加されます）
- **検証 UI の 3 ステップにはブラウザバインディング Cookie が必須です。** `user_code` はフロー開始者に既知である前提のため、CSRF トークン単独では承認強要もログイン CSRF も防げません。この Cookie は `transaction-binding` feature とは独立に常時有効で、curl で手動実行する場合は cookie jar（`-c` / `-b`）が必要です
- **`scope` は必須で `openid` を含む必要があります。** RFC 8628 §3.1 では OPTIONAL ですが、本 OP は認可エンドポイントと同じプロファイル制限を課します
- **`user_code` の総当たりに対するレート制限は実装していません。** RFC 8628 §5.1 の対策のうちエントロピー（20^8）と短い TTL は実装済みですが、レート制限はデプロイ基盤の責務です
- **Experimental です。** API・設定値・生成コードの構造はマイナーリリースでも破壊的に変更されることがあります
