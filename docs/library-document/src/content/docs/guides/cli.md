---
title: CLI Guide
description: Generate OpenID Provider code with the maronn-oidc CLI.
---

`@maronn-openid-connect/cli` は、Authorization Code Flow（OAuth 2.1 / OIDC Core 1.0 準拠）を実装した OP コード一式を生成する CLI ツールです。生成コードは `@maronn-openid-connect/core` のロジックを HTTP に配線したもので、利用者はこのコードを改造しながら仕様を検証します。

生成される各エンドポイント（`routes/authorize.ts` / `token.ts` / `userinfo.ts` / `introspection.ts` / `revocation.ts`）は、core の合成関数を1回呼ぶ形ではなく、クライアント認証・クライアント解決・期限・redirect URI・PKCE・scope・再利用検知・ID Token クレーム構築などの機能単位ステップを順に呼び出す形で生成されます。必要なステップを消す、独自検証を間に足す、ID Token に独自クレームを足す、といった PoC 向けの改修を生成コード上で直接行えます。

## Commands

```bash
# コード生成
maronn-oidc generate <framework> [options]

# 生成 + 既存エントリファイルへの組み込み（Next.js 以外）
maronn-oidc setup <framework> [options]
```

対応フレームワーク: `hono`, `express`, `fastify`, `nextjs`

`setup` は生成に加えて、エントリファイル内のプレースホルダーコメント（`// <!-- OIDC_IMPORT_PLACEHOLDER -->` と `// <!-- OIDC_SETUP_PLACEHOLDER -->`）を `applyOidc` の import と呼び出しに置換します。Next.js は App Router のファイル規約に従うため `setup` 非対応で、`maronn-oidc generate nextjs --output ./src/app` を使います。

### setup に必要なプレースホルダー

`setup` は、エントリファイルに次の 2 種のコメントが**両方**書かれていることを前提とします。

```typescript
import { Hono } from 'hono';
// <!-- OIDC_IMPORT_PLACEHOLDER -->
const app = new Hono();
// <!-- OIDC_SETUP_PLACEHOLDER -->
```

- 2 種のうち片方でも欠けている場合、`setup` は**エントリファイルを一切書き換えずに**エラーを表示し、終了コード 1 で終わります。片方だけを置換すると、OP がマウントされないまま成功したように見えたり、import の無い `applyOidc(app);` が書き込まれてエントリファイルが型検査を通らなくなるためです。エラーには欠けているプレースホルダー名と記述例が表示されるので、追記して `setup` を再実行してください。なお、コード生成自体は配線判定より前に完了しているため、生成物は出力先に残ります。
- 既に `applyOidc` の import と呼び出しが両方存在する場合（＝一度 `setup` 済み）は、`Already patched (no changes):` と表示してファイルを書き換えずに成功終了します。`setup` の再実行は安全です。

## Options

| オプション | 説明 |
|---|---|
| `--output, -o <dir>` | 出力先ディレクトリ（既定: `./oidc-provider`） |
| `--entry, -e <file>` | setup 時にパッチするエントリファイル（既定: `./src/index.ts`） |
| `--enable <features>` | 有効化する機能（カンマ区切り・複数回指定可） |
| `--disable <features>` | 既定セットから外す機能（カンマ区切り・複数回指定可） |
| `--scope <scopes>` | 生成 OP が受け付けるカスタムスコープ（カンマ区切り・複数回指定可） |
| `--help, -h` | ヘルプ表示 |

## Generated Files

```
oidc-provider/
├── app.ts / apply.ts     # OP 本体と既存アプリへの組み込み関数
├── config.ts             # ProviderConfig・クライアント登録（既定値はローカル検証専用）
├── scopes.ts             # スコープポリシー（--scope 指定時のみ）
├── store.ts              # インメモリストア（認可コード・トークン・セッション等）
├── resolvers.ts          # セッション・同意状態の resolver
├── views.ts              # ログイン / 同意 / エラー画面のデフォルト UI
├── routes/               # 各エンドポイントのルート実装
└── conformance.test.ts   # 生成 OP の想定挙動を固定する契約テスト
```

## Feature Toggles

生成される OP の機能は、既定の全部入り構成から機能単位で増減できます。

```bash
# リフレッシュトークンとイントロスペクションを外した OP を生成
maronn-oidc generate hono --disable refresh-token,introspection

# PKCE を任意化（confidential client の非PKCEフローを許可）
maronn-oidc generate express --disable pkce
```

| 機能名 | 既定 | `--disable` 時の挙動 |
|---|---|---|
| `pkce` | 有効 | PKCE を任意化する（`allowNonPkceAuthorizationCodeFlow: true`）。明示的な confidential client の完全な非PKCEリクエストのみ許可され、public client や不正な PKCE 値は引き続き拒否される |
| `refresh-token` | 有効 | `refresh_token` grant を `unsupported_grant_type` で拒否。`offline_access` は付与されず、リフレッシュトークンは発行されない。discovery からも除去される |
| `introspection` | 有効 | RFC 7662 introspection エンドポイント（`/introspect`）を生成しない |
| `revocation` | 有効 | RFC 7009 revocation エンドポイント（`/revoke`）を生成しない |
| `request-object` | 有効 | `request` パラメータ（Request Object by value, OIDC Core 1.0 §6.1）を `request_not_supported` で拒否。discovery は `request_parameter_supported: false` を広告する |

Basic OP に必須の機能（authorize / token / userinfo / discovery / jwks / login / consent）はトグル対象外で、常に生成されます。
未知の機能名や、同じ機能を `--enable` と `--disable` の両方に指定した場合はエラーになります。

### Optional Features

Optional 機能は **stable な core の実装** ですが、**既定では無効**です。`--enable` で明示したときだけ生成されます。

Experimental と違い API は安定しています。既定から外している理由は別で、**どの OIDC Core / OAuth 2.1 の条文もこれを要求していない**ためです。このライブラリの既定生成物は「仕様そのもの」に保ち、「この仕様で自分の要件が実現できるか」を確かめている利用者が、ライブラリ独自のハードニングに答えを混ぜられないようにしています。

```bash
maronn-oidc generate hono --enable transaction-binding
```

| 機能名 | 既定 | 内容 | 関連仕様 |
|---|---|---|---|
| `transaction-binding` | 無効 | 認可トランザクションを、それを開始した User-Agent に HttpOnly Cookie（`oidc_txn_<transaction_id>`）で束縛する。有効時は `/login`・`/consent` の GET / POST が Cookie を提示しない相手を 400 で拒否するため、URL を流れる `transaction_id` が漏れてもフローを進行できない | OIDC Core 1.0 §3.1.2.3 / §3.1.2.4（同一性の保証手段は実装責務）。OWASP CSRF Prevention Cheat Sheet |

**有効化するとブラウザ以外から触りにくくなります。** curl や HTTP クライアントで `/authorize` → `transaction_id` を手で拾って `/login` を叩く、という進め方は Cookie を持ち回らないと 400 になります（`curl -c cookies.txt -b cookies.txt` 相当が必要）。手元で仕様を試す段階では無効のまま、束縛の挙動そのものを検証したいときに有効化する、という使い分けを想定しています。

### Experimental Features

Experimental 機能は上記いずれとも別カテゴリで、**既定では無効**です。`--enable` で明示したときだけ生成され、実装は別 package の `@maronn-openid-connect/experimental` にあります。

```bash
maronn-oidc generate hono --enable par
pnpm add @maronn-openid-connect/core @maronn-openid-connect/experimental
```

`@maronn-openid-connect/core` は `@maronn-openid-connect/experimental` の peerDependency なので、両方を入れてください（CLI のインストール案内も両方を出力します）。experimental のほうが速く更新されるため、バージョン番号が揃っていない状態は正常です。

| 機能名 | 既定 | 内容 | 準拠仕様 |
|---|---|---|---|
| `par` | 無効 | Pushed Authorization Requests エンドポイント（`/par`）と認可エンドポイントの `request_uri` 解決 | RFC 9126 |

API は安定しておらず、破壊的に変更されることがあります。詳細と注意点は [Experimental機能とは](../../experimental/) を参照してください。

## Custom Scopes

標準スコープ（`openid` / `profile` / `email` / `address` / `phone` / `offline_access`）は生成 OP 自身が扱います。それ以外に受け付けるスコープは、生成時に `--scope` で宣言します。

```bash
maronn-oidc generate hono --scope reports.read,reports.write
```

宣言すると `scopes.ts`（スコープポリシー）が生成され、生成 OP は次のようになります。

- discovery の `scopes_supported` に宣言したスコープが載る
- 宣言していないスコープ値を要求した認可リクエストは `invalid_scope` で拒否される（RFC 6749 §3.3 / §4.1.2.1）
- ユーザーごとの絞り込みは、生成された `scopes.ts` に書く

宣言が 1 つも無ければ `scopes.ts` も許容リストのチェックも生成しないため、既定の生成物の挙動は変わりません。

許容リストのチェックは `applyOfflineAccessPolicy` の**後**に置かれます。付与条件を満たさない `offline_access` は OIDC Core 1.0 §11 に従ってそこで既に落ちているため、「無視する」挙動が `invalid_scope` に変わることはありません。`--enable device-authorization-grant` / `--enable ciba` を有効にした場合は、デバイス認可エンドポイントとバックチャネル認証エンドポイントにも同じ許容リストが適用されます。

### ユーザーごとの絞り込みは生成コードに書く

「誰にどのスコープを許すか」は CLI のオプションにしていません。運用ごとに条件（ロール、テナント、DB 参照）が違い、生成コードを改造しながら検証するというこのライブラリの使い方に合わないためです。代わりに、生成される `scopes.ts` に絞り込みの入口を用意し、判断が必要な全ステップから呼び出した状態で生成します。

```typescript
// scopes.ts（生成物）
export const RESTRICTED_SCOPE_SUBJECTS: Record<string, readonly string[]> = {
  'reports.read': ['alice'],   // 手早く絞るならここに書く
};

export async function resolveGrantableScopes(
  requested: readonly string[],
  subject: string,
): Promise<string[]> {
  // ロール・テナント・DB 参照など、複雑な条件はここに書く
  return requested.filter((scope) => { /* ... */ });
}
```

`resolveGrantableScopes()` は End-User が確定した後に呼ばれ、次の箇所からすでに `await` されています。async なので、DB / KV 参照へ置き換えても呼び出し側の変更は要りません。

| 呼び出し元 | タイミング |
|---|---|
| `routes/consent.ts` | 同意画面の表示内容と、承認時の付与スコープ |
| `routes/authorize.ts` | SSO fast path と `prompt=none`（同意画面を出さずに付与する経路） |
| `routes/device.ts` / `routes/ciba-verification.ts` | device / CIBA の承認ステップ（該当機能を有効にした場合） |

SSO と `prompt=none` では、**保存済み同意を引く前**にポリシーを適用します。絞る前の scope で同意を探すと、そのユーザーが持てないスコープをキーに検索することになり、いつまでも一致しないためです。

落としたスコープはリクエストを失敗させず、付与スコープを狭めます。RFC 6749 §3.3 が要求より狭いスコープの発行を認めており、トークンレスポンスの `scope` に実際の付与内容が載ります。リクエストごと拒否したい場合は、呼び出し元で throw してください。

なお、カスタムスコープに対応する UserInfo クレームはありません（OIDC Core 1.0 §5.4 が定義するのは profile / email / address / phone のみ）。独自クレームを返す場合は `routes/userinfo.ts` を編集してください。

## Contract Test (conformance.test.ts)

生成物には、選択した機能構成に合わせた契約テスト `conformance.test.ts` が含まれます。生成 OP がこのリポジトリの想定する Basic OP 挙動を満たすことを固定するテストで、無効化した機能については「無効であること」（404 応答、`unsupported_grant_type` / `request_not_supported` の拒否、discovery メタデータの不在など）を検証します。

生成コードは自由にカスタマイズできますが、このテストが通らなくなった場合は担保対象の挙動から外れている可能性があります。

## After Generation

1. ProviderConfig・署名鍵・クライアント resolver を環境変数 / DB / KV から供給する
2. `config.ts` のデフォルト値はローカル検証専用として扱う
3. 依存をインストールしてサーバーを起動する（例: `pnpm add hono @maronn-openid-connect/core`）

具体的な組み込み手順は [Quick Start](../../quick-start/) を参照してください。
