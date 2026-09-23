---
title: RP-Initiated Logout
description: RP からの遷移で OP のブラウザセッションを終了する OpenID Connect RP-Initiated Logout 1.0 の試験実装。
---

:::caution[Experimental]
この機能は**試験実装**です。API・設定・生成コードの構造は予告なく変更されることがあります。
`@maronn-openid-connect/experimental` のバージョンを固定して使ってください。詳細は [Experimental機能とは](../) を参照してください。
:::

## 概要

この OP はログインと同意を実装していますが、既定の生成物にはログアウトの経路がありません。
RP 側でログアウトしても OP のブラウザセッションは残り続け、次の認可リクエストは再認証なしで通ります。

RP-Initiated Logout 1.0 は、RP がユーザーエージェントを OP へ遷移させてセッションを終了させる **end_session_endpoint** を定義します。
`--enable rp-initiated-logout` で生成した OP は `GET|POST /logout` を提供し、discovery に `end_session_endpoint` を公表します。

```text
GET /logout?id_token_hint=eyJ...&post_logout_redirect_uri=https%3A%2F%2Frp.example%2Floggedout&state=af0ifjsldkj
Cookie: session_id=abc123

HTTP/1.1 302 Found
Location: https://rp.example/loggedout?state=af0ifjsldkj
Set-Cookie: session_id=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0
```

有効な `id_token_hint` が現在のセッションの End-User を指す場合だけ、この例のように即座にログアウトします。
それ以外の要求（ヒントなし、検証に通らないヒント、別ユーザーのセッション）は、すべて確認画面に落ちます。
仕様が確認を要求する（§2 MUST）のは、確認なしのログアウトエンドポイントが「リンクを踏ませるだけで被害者のセッションを終了させる」DoS の道具になるためです（§7）。

## 対応仕様

- [OpenID Connect RP-Initiated Logout 1.0](https://openid.net/specs/openid-connect-rpinitiated-1_0.html)（Final, 2022-09-12）

次はスコープ外です。

- Session Management 1.0（`check_session_iframe` / `session_state`）
- Front-Channel Logout 1.0 / Back-Channel Logout 1.0（他 RP への伝播。`sid` クレームも発行しません）
- 期限切れ `id_token_hint` の受理（§2 の SHOULD。後述）

## ユースケース

- SSO 構成の PoC で、RP のログアウトボタンから OP セッション終了までの全周を検証する
- `post_logout_redirect_uri` の登録運用と完全一致検証の挙動（未登録 URI・部分一致・クエリ差分で何が起きるか）を確認する
- ログアウト後の `prompt=none` の失敗（`login_required`）や online refresh token の失効など、セッション終了の波及を検証する

## 前提条件

追加の前提はありません。
ログアウトが使うセッション基盤（`session_id` Cookie と browser session store）とヒント検証用の JWKS プロバイダは、どのビルドでも常に生成されます。

## 有効化

```bash
maronn-oidc generate hono --enable rp-initiated-logout
pnpm add hono @maronn-openid-connect/core @maronn-openid-connect/experimental
```

有効にすると、`/logout`（GET / POST）と確認画面の承認先 `/logout/approve`（POST）が生成され、discovery に `end_session_endpoint` が公表されます。
有効にしない場合、生成コードは従来と変わらず、`/logout` は存在しません（404）。

## 設定

リダイレクトを許す戻り先は、生成された `routes/logout.ts` の `rpInitiatedLogoutConfig` に**クライアントごとに**登録します。

```typescript
import { rpInitiatedLogoutConfig } from './oidc-provider/routes/logout.js';

rpInitiatedLogoutConfig.postLogoutRedirectUris = {
  'my-client': ['https://rp.example/loggedout'],
};
```

これは authorize の `redirect_uri` とは別の登録簿です（仕様上もクライアントメタデータ `post_logout_redirect_uris` は独立しています）。
既定は空で、その場合すべてのリダイレクト要求はリダイレクトされず完了画面に落ちます（fail-closed）。

## 生成されるもの

| ファイル | 内容 |
|---|---|
| `routes/logout.ts` | `GET\|POST /logout` と `POST /logout/approve`、設定オブジェクト `rpInitiatedLogoutConfig` |
| `store.ts`（追記） | 確認画面の CSRF cookie ヘルパーとセッション Cookie の破棄ヘルパー |
| `views.ts`（追記） | 確認画面 `logoutConfirmationPage` と完了画面 `logoutCompletedPage`（`views` オプションで差し替え可能） |
| `routes/discovery.ts`（追記） | `end_session_endpoint` メタデータ |
| `conformance.test.ts`（追記） | ログアウト経路の契約テスト |

## 判定規則

リクエストは次の順で解釈されます。

1. **クライアントの特定**：ヒント検証に使う期待 `aud` は、`client_id` パラメータがあればその値、なければヒント payload の `aud`（文字列ならその値、配列なら `azp`、`azp` がなく要素が 1 つならその要素）。特定できなければヒントは無効
2. **ヒントの検証**：core の `validateIdTokenHint` が署名・`iss`・`aud`・`exp` を検証。失敗はすべて「ヒントなし」と同じ扱いで、理由は応答に出ません
3. **即時ログアウト**：ヒントが有効で、現在のブラウザセッションが存在し、ヒントの `sub` がセッションの subject と一致する場合のみ
4. **確認画面**：それ以外のすべて。承認の POST があって初めてセッションが消えます
5. **リダイレクト**：ヒントが有効で、`post_logout_redirect_uri` が登録値と**完全一致**（文字列比較）した場合のみ。`state` はそのままクエリで返ります。確認画面を経由した場合も、承認後に同じ条件でリダイレクトされます

### 有効なヒントで確認画面を省く設計判断

仕様の §2 は確認を「ヒントがない、または現在のセッションのものでない場合」に要求し、有効なヒントがある場合の確認は SHOULD（省略可）です。
この実装は、RP のログアウト操作が End-User 自身の操作であり、有効なヒントは RP がその End-User にトークンを発行された当人であることを示す、という判定で確認を省きます。
Keycloak など主要実装も同じ省略をしており、確認の要否を変える構成値は持ちません。

### 期限切れヒントは受理しない

仕様は「RP に現在または最近のセッションがあれば `exp` を過ぎた ID Token も受理すべき（SHOULD）」としますが、この実装は期限切れヒントを無効なヒントとして扱い、確認画面の経路に落とします。
core の `validateIdTokenHint` が `exp` 超過を拒否するためで、確認を経ればログアウト自体は完了できます（安全側の不採用）。

## API 利用例

生成コードが使う判定ロジックは、HTTP にもストアにも触れない純関数として公開されています。
ルートを書き換えるときも、この関数群に判定を寄せたまま入出力だけ差し替えられます。

```typescript
import {
  parseEndSessionRequest,
  extractIdTokenHintAudience,
  decideLogoutFlow,
  resolvePostLogoutRedirect,
} from '@maronn-openid-connect/experimental/rp-initiated-logout';

const request = parseEndSessionRequest(new URL(req.url).searchParams);
const expectedAudience =
  request.clientId ?? extractIdTokenHintAudience(request.idTokenHint ?? '');
// verifiedHint は core の validateIdTokenHint の戻り値（失敗時は null）
const decision = decideLogoutFlow({
  verifiedHint,
  expectedAudience,
  clientIdParam: request.clientId,
  sessionSubject: session?.subject ?? null,
});
const redirectTo = resolvePostLogoutRedirect({
  postLogoutRedirectUri: request.postLogoutRedirectUri,
  state: request.state,
  verifiedClientId: decision.verifiedClientId,
  registeredUris: registered,
});
```

## エラー処理

| 状況 | 応答 |
|---|---|
| ヒントなし・無効・`client_id` 不一致・セッション不一致 | `200 OK` 確認画面（理由は表示しません） |
| 即時ログアウトで URI 不一致・未指定 | `200 OK` 完了画面（`state` はどこにも出ません） |
| `/logout/approve` の CSRF 検証失敗 | `400 Bad Request`（何も削除しません） |

ログアウトエンドポイントはユーザーエージェントが直接開く画面なので、OAuth 形式のエラー JSON（`error` / `error_description`）を返す経路はありません。

## セキュリティ上の注意

### 確認画面の承認は cookie とトークンの対で守られる

確認画面を描画するとき、OP は乱数シークレットを発行し、HttpOnly cookie とフォームの hidden `csrf_token` の両方でそのブラウザへ渡します。
`/logout/approve` は両者が同じシークレットを提示したときだけ動きます。
攻撃者は自分のブラウザで有効な対を取得できますが、その cookie を被害者のブラウザに設定できないため、クロスサイトの偽造 POST は照合で落ちます。
どちらか一方だけでは承認されません。

この cookie は、描画時に確定したリダイレクト先も運びます。
`id_token_hint` やリダイレクト先パラメータが HTML のフォームに書き戻されることはありません。

### そのほかの論点

- **オープンリダイレクト**：リダイレクトは検証済みクライアントの登録値と完全一致した場合だけです。正規化・前方一致・クエリ無視はしません
- **セッション存在のオラクル**：確認画面と完了画面の文言は、セッションの有無や失敗理由で変わりません
- **`state` の反射**：`state` は解釈されず、URL API のクエリ付加でのみ出力されます（URL エンコードを通ります）。画面には出ません
- **盗まれた ID Token**：被害者の有効な ID Token を持つ攻撃者が被害者のブラウザにログアウトリンクを踏ませると、即時ログアウトが成立します。これは有効なヒントの提示をログアウト権限の証拠とする仕様の信頼モデルの帰結で、この実装はそのまま受容しています（ID Token が盗まれた時点で、ログアウト強要より重大な被害が既に成立しています）

## トークン失効との境界

ログアウトが消すのは OP のブラウザセッションだけです。

- **online refresh token**（`offline_access` なしで発行されたもの）は、セッション消滅により次の利用が `invalid_grant` になります。これは core の既存機構の帰結で、この機能がトークンを失効させるのではありません
- **offline refresh token とアクセストークン**は有効なまま残ります。失効させたい場合は revocation エンドポイント（RFC 7009）を使ってください

## 既知の制約

- 他 RP への伝播（Front-Channel / Back-Channel Logout）はありません。ログアウトするのはこの OP のセッションだけです
- 期限切れ `id_token_hint` の受理（SHOULD）は実装していません
- `logout_hint` と `ui_locales` は受理しますが動作を変えません
- エンドポイントのパス（`/logout` / `/logout/approve`）は固定です

## core 機能との違い

| 機能 | 対象 | 消えるもの |
|---|---|---|
| `prompt=login` | 再認証の強制 | 何も消えません（セッションは残ります） |
| revocation（RFC 7009） | トークン単位の失効 | 指定したトークンとその家系 |
| RP-Initiated Logout | セッション単位の終了 | ブラウザセッション（と、その帰結として online refresh token の有効性） |

## トラブルシューティング

- **登録した URI に戻らず完了画面が出る**：`rpInitiatedLogoutConfig.postLogoutRedirectUris` の値とリクエストの `post_logout_redirect_uri` が文字列として完全一致しているか確認してください。末尾スラッシュやクエリの差分も不一致です
- **有効なはずのヒントで確認画面が出る**：ヒントの `exp` が切れていないか、`aud` が意図したクライアントか、`client_id` パラメータとヒントの `aud` が一致しているかを確認してください。理由は応答に出ない設計です
- **確認画面の承認が 400 になる**：確認画面の描画から時間が経つと CSRF cookie（10 分）が失効します。`/logout` を開き直してください

## 参考資料

- [OpenID Connect RP-Initiated Logout 1.0](https://openid.net/specs/openid-connect-rpinitiated-1_0.html)
- [RFC 6749 §10.15: Open Redirectors](https://www.rfc-editor.org/rfc/rfc6749#section-10.15)
