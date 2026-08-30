---
title: Cross-App Access / ID-JAG
description: SSO で同じ IdP を信頼する 2 つのアプリの間の API アクセスを、IdP が仲介する Cross-App Access（ID-JAG）の試験実装。発行側と受領側の両方に対応。
---

:::caution[Experimental]
この機能は**試験実装**です。API・設定・生成コードの構造は予告なく変更されることがあります。
さらに準拠先の仕様自体が IETF draft（draft-ietf-oauth-identity-assertion-authz-grant-04）であり、改版でクレームや必須性が変わる可能性があります。
`@maronn-openid-connect/experimental` のバージョンを固定して使ってください。詳細は [Experimental機能とは](../) を参照してください。
:::

## 概要

企業の SaaS 群は SSO で同じ IdP を信頼しているのに、アプリ同士の連携（Wiki がチャットの内容を埋め込む、AI エージェントが外部ツールを呼ぶ）だけは IdP の外で個別の OAuth 同意として行われてきました。
IdP の管理者からはアプリ間の接続が見えず、ユーザーはアプリのペアごとに同意画面を通過し、各アプリが他アプリのリフレッシュトークンを長期保持します。

**Cross-App Access（XAA）** は、このアプリ間アクセスの許可判断を IdP へ移すパターンです。
その中核が **ID-JAG（Identity Assertion JWT Authorization Grant）** で、アプリは手元の ID トークンを IdP で ID-JAG に交換し（Token Exchange, RFC 8693）、それを相手アプリの認可サーバーへ JWT Bearer Grant（RFC 7523）として提示してアクセストークンを得ます。
ユーザーの追加同意は発生せず、どのアプリ間アクセスを許すかは IdP 側の許可リストが決めます。

この機能は、1 つの生成 OP に両方の役割を追加します。

- **発行側（IdP）**: Token Exchange で `requested_token_type=urn:ietf:params:oauth:token-type:id-jag` を受け、自 OP 発行の ID トークンを検証して ID-JAG を発行する
- **受領側（リソースアプリの認可サーバー）**: `urn:ietf:params:oauth:grant-type:jwt-bearer` grant で、信頼設定済みの外部 IdP が署名した ID-JAG を検証し、自分のアクセストークンを発行する

生成 OP を 2 インスタンス起動して互いを設定で信頼させると、XAA の 4 ステップ（SSO → Token Exchange → ID-JAG 提示 → API アクセス）を完結して再現できます。

```text
Requesting App          IdP OP                   Resource App の AS
  |--(1) SSO ログイン --->|                          |
  |<----- ID Token ------|                          |
  |--(2) Token Exchange->|  ID トークンを検証し        |
  |<----- ID-JAG --------|  ID-JAG を署名発行         |
  |--(3) jwt-bearer + ID-JAG ---------------------->|  署名・aud・client_id を検証
  |<----- Access Token（Resource App の AS が発行）---|
  |--(4) API リクエスト（Access Token 添付）---------->
```

## 対応仕様

| 仕様 | 対応範囲 |
|---|---|
| ID-JAG draft §3.1 | ID-JAG のクレーム（iss / sub / aud / client_id / jti / exp / iat / scope / resource / auth_time / acr / amr / act）と `typ: oauth-id-jag+jwt` |
| ID-JAG draft §4.3 | 発行リクエスト（`audience` 必須、subject_token は ID トークンと refresh token）と処理規則（assertion の aud とクライアントの一致検証を含む） |
| ID-JAG draft §4.3.2 / §4.3.3 | refresh token の subject_token（`allowRefreshTokenSubjects`、既定 true）。検証は通常の refresh_token grant と同一（rotation 再利用で family 失効、online RT のセッション生存確認）。RT は消費しない |
| ID-JAG draft §9.7（拡張） | `actor_token` と `act` クレーム（`allowActorTokens`、既定 false の opt-in）。ID トークンは組込み検証、それ以外の種別は `actorTokenResolver`（デプロイ側の検証フック）で受理。受領側は act を発行アクセストークンへ引き継ぐ |
| ID-JAG draft §4.3.4 | 発行レスポンス（`token_type: N_A`、refresh_token なし） |
| ID-JAG draft §4.4 | jwt-bearer での受領（typ / aud / client_id の MUST 検証、refresh_token なし、有効期間内の再提示可） |
| ID-JAG draft §7 | AS metadata（`identity_chaining_requested_token_types_supported` / `authorization_grant_profiles_supported`） |
| ID-JAG draft §9.3 | 同一トラストドメイン内での利用禁止（発行側と受領側の二重ガード） |
| ID-JAG draft §3.2（sub_id / SAML NameID） | **非対応** |
| ID-JAG draft §4.3（saml2 subject） | **非対応**（明示的に拒否） |
| RFC 9396（authorization_details / RAR） | **非対応**（明示的に拒否） |
| DPoP による sender-constraining（draft §9.8） | **非対応** |

## ユースケース

- 「アプリ A がアプリ B のデータをユーザーの再同意なしで読む」エンタープライズ SSO 拡張構成を、IdaaS 契約前に手元で再現する
- AI エージェントが企業 IdP の仲介で外部ツールの API トークンを取得する構成（draft Appendix A.4）の検証
- Token Exchange と JWT Bearer Grant の連鎖をプロトコルレベルで確認する学習目的の PoC

## 前提条件

- 生成 OP を `--enable id-jag` で作成していること
- 要求側クライアントが **confidential client** であること（public client は両側で拒否されます）
- 発行を要求するクライアントの `grantTypes` に Token Exchange の URN、ID-JAG を提示するクライアントの `grantTypes` に jwt-bearer の URN が登録されていること
- 発行側の `subject_token` が**その OP 自身が発行した ID トークン**（`aud` が要求クライアント自身であること）、または `allowRefreshTokenSubjects` 有効時は**その OP 自身が発行した refresh token**（`openid` scope を持つ grant のもの）であること
- `actor_token` を使う場合は `idJagConfig.allowActorTokens` を有効化すること。actor_token が ID トークンなら、その OP 発行・要求クライアント宛てであること。ID トークン以外の種別を使うなら、その種別の内容検証を行う `idJagConfig.actorTokenResolver` をデプロイ側コードで設定してあること
- 要求側クライアントが発行側 IdP と受領側 AS の両方で**同じ client_id** を使っていること（client_id の対応表は初期実装では持ちません）

## 有効化

```bash
maronn-oidc generate hono --enable id-jag
pnpm add @maronn-openid-connect/core @maronn-openid-connect/experimental
```

`--enable id-jag` を付けずに生成した出力は、この機能が存在しなかった頃と**バイト単位で同一**です。
既存の `--enable token-exchange` との併用もできます。その場合、`requested_token_type=...id-jag` の要求だけが ID-JAG の分岐へ入り、それ以外の交換は従来どおり Token Exchange 機能が処理します。

## 生成されるもの

| ファイル | 内容 |
|---|---|
| `routes/token.ts` | 発行分岐（Token Exchange 内）、受領分岐（jwt-bearer）、設定値 `idJagConfig`、信頼 IdP の JWKS 取得ヘルパ、`IdJagError` の catch 分岐 |
| `routes/discovery.ts` | `grant_types_supported` への両 URN の追加、draft §7 の 2 つのメタデータ |
| `config.ts` | サンプルクライアントの `grantTypes` への両 URN の追加 |
| `conformance.test.ts` | XAA の契約テスト（発行・受領・discovery） |

**新しいエンドポイントは増えません。** 既存のトークンエンドポイントに分岐が 2 つ加わるだけです。

## 設定

生成された `routes/token.ts` が `idJagConfig` を export します。

```typescript
export const idJagConfig = {
  // 発行側: ID-JAG を発行してよいリソース AS の issuer。デフォルトは空（fail safe）
  allowedAudiences: [] as string[],
  // ID-JAG の有効期間（秒）。短命にして再発行で回す前提
  idJagLifetimeSeconds: 300,
  // 発行側: 許可する scope の上限。undefined は素通し（受領側ポリシーに委ねる）
  allowedScopes: undefined as string[] | undefined,
  // 発行側: refresh token を subject_token として受けるか（draft §4.3 MAY）。
  // refresh-token feature 有効時のみ生成される。検証は通常の refresh grant と同一
  allowRefreshTokenSubjects: true,
  // 発行側: actor_token を受けて act クレームを発行するか（draft 範囲外の opt-in 拡張）
  allowActorTokens: false,
  // 発行側: id_token 以外の actor_token 種別の内容検証を担うデプロイ側フック。
  // リクエスト構造と戻り値の構造はライブラリが検証し、トークン内容の検証は
  // この関数の責務。未設定なら id_token 以外は invalid_request
  actorTokenResolver: undefined as IdJagActorTokenResolver | undefined,
  // 受領側: 信頼する IdP。jwks（インライン）か jwksUri（取得して 300 秒キャッシュ）
  trustedIdentityProviders: [] as Array<{ issuer: string; jwksUri?: string; jwks?: JwkSet }>,
};
```

どちらの許可リストも空のままでは、ID-JAG は 1 枚も発行されず 1 枚も受理されません。
`allowedAudiences` へ issuer を追加することは、そのアプリ間アクセスを**ユーザー全員に代わって許可する**ことと同じ意味を持ちます。XAA にはユーザーの同意画面が無いためです。

## 使い方（バックチャネルの 2 ステップ）

SSO で取得済みの ID トークンを、まず IdP で ID-JAG に交換します。

```bash
curl -s -X POST https://idp.example.com/token \
  -d 'grant_type=urn:ietf:params:oauth:grant-type:token-exchange' \
  -d 'requested_token_type=urn:ietf:params:oauth:token-type:id-jag' \
  -d 'audience=https://as.resource-app.example' \
  -d 'scope=openid profile' \
  -d "subject_token=${ID_TOKEN}" \
  -d 'subject_token_type=urn:ietf:params:oauth:token-type:id_token' \
  -d 'client_id=my-client' -d 'client_secret=...'
# => {"issued_token_type":"urn:ietf:params:oauth:token-type:id-jag",
#     "access_token":"<ID-JAG>","token_type":"N_A","expires_in":300,"scope":"openid profile"}
```

`token_type` が `N_A` であることに注意してください。ID-JAG はアクセストークンではなく、API へ直接提示しても使えません。
次に、リソースアプリの認可サーバーへ jwt-bearer として提示します。

```bash
curl -s -X POST https://as.resource-app.example/token \
  -d 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer' \
  -d "assertion=${ID_JAG}" \
  -d 'client_id=my-client' -d 'client_secret=...'
# => {"access_token":"...","token_type":"Bearer","expires_in":3600,"scope":"openid profile"}
```

応答に `id_token` と `refresh_token` は含まれません。
アクセストークンが切れたら、ID-JAG が有効なうちは同じものを再提示し、切れていたら手元の ID トークンで新しい ID-JAG を取り直します（draft §4.4.3。ID-JAG がリフレッシュトークンの代替になります）。
ID トークンも切れている場合は、`subject_token_type=urn:ietf:params:oauth:token-type:refresh_token` で IdP のリフレッシュトークンをそのまま subject にでき、ユーザーを再ログインさせずに ID-JAG を更新できます。

代理実行を記録したいときは、`idJagConfig.allowActorTokens` を有効にしたうえで `actor_token`（actor の ID トークン）と `actor_token_type=...id_token` を追加します。
発行される ID-JAG に `act: {"sub":"<actor の sub>"}` が入り、redemption 後のアクセストークンにも同じ `act` が引き継がれます。

actor_token に ID トークン以外の種別（アクセストークンや独自 URN。RFC 8693 は任意の token type identifier を許します）を使いたいときは、`idJagConfig.actorTokenResolver` に自分の検証ロジックを設定します。
リクエスト構造（`actor_token` と `actor_token_type` の対応規則、非空、opt-in の gate）とリゾルバ戻り値の構造（`sub` 必須、`sub` / `act` 以外の属性の除去）はライブラリが検証し、トークンの内容（署名・失効・帰属）の検証はリゾルバの責務です。
リゾルバは有効な actor に対して act 値（`{ sub, act? }` のチェーン可）を返し、無効なら `null` を返します（固定文言の `invalid_request` になります）。`IdJagError` を投げて応答を指定することもでき、それ以外の例外は `server_error` になります。
`actor_token_type=...id_token` は常に組込み検証で処理され、リゾルバでは差し替えられません。

```typescript
// 例: 自 OP 発行のアクセストークンを actor_token として受ける
// （hono-cloudflare サンプルの app.ts に同じデモがあります）
idJagConfig.actorTokenResolver = async ({ actorToken, actorTokenType, clientId }) => {
  if (actorTokenType !== 'urn:ietf:params:oauth:token-type:access_token') return null;
  const info = await accessTokenStore.get(actorToken);
  if (info === undefined || info.clientId !== clientId) return null;
  if (info.expiresAt <= Math.floor(Date.now() / 1000)) return null;
  return { sub: info.sub };
};
```

## エラー

| 状況 | error |
|---|---|
| subject_token（ID トークン / refresh token）の検証失敗 | `invalid_request`（失敗理由を区別しない固定文言） |
| actor_token の検証失敗（`allowActorTokens` 有効時。組込み検証の失敗と `actorTokenResolver` の `null`）、無効時の actor_token の存在、リゾルバ未設定時の非 id_token 種別 | `invalid_request`（検証失敗は固定文言） |
| `actorTokenResolver` の例外・malformed な戻り値 | `server_error`（`IdJagError` を投げた場合はその内容） |
| `audience` が許可リスト外、または自 OP 自身 | `invalid_target` |
| assertion の iss が信頼リスト外、または署名不正 | `invalid_grant`（両者を区別しない固定文言。信頼リストの探索防止） |
| assertion の typ / aud / exp / client_id の不一致 | `invalid_grant`（個別の文言） |
| grantTypes 未登録・public client | `unauthorized_client` |

## 制限事項

- subject_token は ID トークンと（`allowRefreshTokenSubjects` 有効時の）refresh token です。SAML assertion は受け付けません
- `authorization_details`（RAR）は明示的に拒否します。`actor_token` は `allowActorTokens` を有効化するまで拒否されます。有効時に受けられる種別は、本 OP 発行・要求クライアント宛ての ID トークン（組込み検証。act は 1 段のみ）と、`actorTokenResolver` を設定した場合のその種別（act はリゾルバが返したチェーンをそのまま発行できます）です
- actor と subject の関係性ポリシー（誰が誰の代理を務めてよいか）の判定は持ちません。ID トークン経路では同じクライアント宛ての有効な ID トークンがあれば actor になれ、リゾルバ経路の判定基準はリゾルバ実装者の責務です
- ID-JAG の `client_id` クレームは IdP で認証したクライアントの client_id をそのまま使います。両 AS で client_id が異なる構成（draft §5 の対応表）には対応していません
- `jti` によるリプレイ拒否は行いません。有効期間内の再提示は draft §4.4.3 が意図する正当な利用形態です（クライアント認証と `client_id` 一致、短い exp が束縛を担います）
- 受領側の subject 解決は「ID-JAG の `sub` をそのままローカル subject にする」に固定です。JIT プロビジョニングはありません

## 関連資料

- [draft-ietf-oauth-identity-assertion-authz-grant-04](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-identity-assertion-authz-grant-04)
- [RFC 8693: OAuth 2.0 Token Exchange](https://datatracker.ietf.org/doc/html/rfc8693)
- [RFC 7523: JWT Profile for OAuth 2.0 Client Authentication and Authorization Grants](https://datatracker.ietf.org/doc/html/rfc7523)
- [Token Exchange (RFC 8693)](../token-exchange/)（既存アクセストークンの同一ドメイン内交換。ID-JAG とは入力と出力の種別が異なります）
