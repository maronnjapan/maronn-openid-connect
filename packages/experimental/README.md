# @maronn-openid-connect/experimental

このディレクトリは試験的に実装したもので、まだ正式にライブラリの機能として提供できていない機能をまとめたものとなります。

## 位置づけ

- `@maronn-openid-connect/core` とは**別 package**です。core の通常動作にこのコードが読み込まれることはありません。
- **API は安定していません。** マイナーリリースでも破壊的に変更されることがあります。本番利用する場合はバージョンを固定してください。
- CLI で `--enable <feature-id>` を明示したときだけ、生成コードがこの package を利用します。デフォルトでは一切参照されません。

## 提供機能

| feature-id | 内容 | 準拠仕様 | import 元 |
|---|---|---|---|
| `par` | Pushed Authorization Requests | RFC 9126 | `@maronn-openid-connect/experimental/par` |
| `token-exchange` | OAuth 2.0 Token Exchange (impersonation) | RFC 8693 | `@maronn-openid-connect/experimental/token-exchange` |
| `jarm` | JWT Secured Authorization Response Mode (signed `query.jwt` only) | JARM (OpenID Foundation Final, 2022-11-09) | `@maronn-openid-connect/experimental/jarm` |

機能ごとに subpath export で提供します。ルート (`.`) からの再エクスポートは提供しません。機能間でコードを共有しないことで、昇格・削除時に他機能へ影響しない構造を保っています。

```bash
maronn-oidc generate hono --enable par
pnpm add @maronn-openid-connect/core @maronn-openid-connect/experimental
```

```typescript
import { handlePushedAuthorizationRequest } from '@maronn-openid-connect/experimental/par';
```

## core とのバージョン関係

`@maronn-openid-connect/core` はこの package の **peerDependency** です（`dependencies` ではありません）。

experimental は core のエラークラス（`AuthorizationError` / `TokenError`）を `instanceof` で判定し、resolver / store を生成コードと受け渡しします。そのためアプリ全体で core のインスタンスが 1 つである必要があります。core を `dependencies` として同梱すると、生成コードが読み込む core と experimental が読み込む core が別インスタンスになり、`instanceof` 判定が静かに false になって、本来 `invalid_request` を返すべき場面が 500 になります。peerDependency にしておくと利用者のアプリが持つ core がそのまま使われるため、この事故が起きません。

**バージョン番号は揃っている必要はありません。** experimental は core より速く publish されるため、`core 0.1.0` + `experimental 0.5.0` のような組み合わせが正常な状態です。互換性の条件は peer range（`>=0.1.0 <1.0.0`）の下限を満たしていることだけで、experimental が新しい core の API を必要とし始めたときにこの下限が上がります。下限を満たしていない場合は npm ならインストールが `ERESOLVE` で失敗し、pnpm なら `✕ unmet peer @maronn-openid-connect/core` が警告されます。

> **`@maronn-openid-connect/experimental@0.0.1` は `@maronn-openid-connect/core@0.0.1` と組み合わせて使えません。**
> 0.0.1 は core のステップ関数（`extractClientCredentials` など）を import しているのに、
> それらを export する core がまだ publish されていない状態で公開されました。この組み合わせでは
> バンドル時に esbuild が `No matching export ... for import "extractClientCredentials"` で落ちます。
> peer range の下限を `>=0.1.0` へ上げて組み合わせられないようにしてあるので、両方を最新へ更新してください。

> リポジトリ側では、core を minor / major で上げるときに experimental も同時にリリースすること、および peer range の下限が「次に publish される core」以上であることを CI で強制しています（`.github/scripts/verify-release-contract.mjs`）。詳細は [RELEASE.md](../../RELEASE.md) の「バージョニング方針」を参照してください。

## 依存方向

```text
packages/cli ────> @maronn-openid-connect/experimental（生成コードの依存として明示）
@maronn-openid-connect/experimental ────> @maronn-openid-connect/core（許可）
packages/core ──X──> packages/experimental（禁止）
```

## 昇格条件

Experimental 機能が core へ昇格する目安は次のとおりです。

1. 生成 OP の conformance テストが 2 サイクル以上安定していること
2. resolver / store 契約への変更要望が収束していること
3. その仕様がリポジトリのロードマップ（例: FAPI 2.0 対応）で必須になったこと

昇格するとその機能は `@maronn-openid-connect/core` へ移り、この package からは削除されます。

## 利用者ドキュメント

`docs/library-document` の Experimental セクションを参照してください。
