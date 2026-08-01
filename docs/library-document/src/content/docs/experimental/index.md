---
title: Experimental機能とは
description: 安定性保証のない試験的機能の位置づけと使い方。
---

Experimental 機能は、**新しい OAuth / OIDC 仕様をいち早く試せるようにするための試験実装**です。
`@maronn-oidc/core` の安定機能とは別の扱いになります。このページを読んでから個別の機能ページへ進んでください。

## 安定性保証はありません

Experimental 機能には**互換性の保証がありません**。

- 関数名・引数・戻り値・型は、マイナーリリースでも予告なく変更されることがあります
- 設定値の名前や既定値が変わることがあります
- 生成コードの構造（ファイル配置・分割単位）が変わることがあります
- 機能そのものが削除されることがあります（仕様が失効した場合など）

利用する場合は `@maronn-oidc/experimental` のバージョンを固定し、アップグレード時は必ず変更履歴（Changeset）を確認してください。

## 本番利用について

Experimental 機能は「自分の要件がこの仕様で実現できるか」を検証するためのものです。
本番環境で使う場合は、少なくとも次を自分の責任で確認してください。

- 生成された in-memory ストアを、永続かつ atomic な実装へ差し替えていること
- アップグレード時に破壊的変更を受け止められる運用になっていること
- 対象仕様の Security Considerations を一次資料で読んでいること

## `@maronn-oidc/core` とは別 package です

Experimental 機能は `@maronn-oidc/experimental` という**別の package** で提供されます。

```text
packages/cli ────> @maronn-oidc/experimental（生成コードの依存）
@maronn-oidc/experimental ────> @maronn-oidc/core
@maronn-oidc/core ──X──> @maronn-oidc/experimental（依存しない）
```

core が experimental に依存することはありません。したがって Experimental 機能を有効にしていない OP の挙動は、この package の存在によって一切変わりません。

機能ごとに subpath export で提供されます。ルート（`@maronn-oidc/experimental`）からの再エクスポートはありません。

```typescript
import { handlePushedAuthorizationRequest } from '@maronn-oidc/experimental/par';
```

## 明示的に有効化する必要があります

Experimental 機能は**デフォルトで無効**です。CLI の `--enable` で feature-id を明示したときだけ、生成コードに含まれます。

```bash
# PAR を有効にして OP を生成する
maronn-oidc generate hono --enable par

# 生成コードが必要とする package を追加する
pnpm add @maronn-oidc/experimental
```

`--enable` を付けずに生成した場合の出力は、Experimental 機能が存在しなかった頃と**バイト単位で同一**です。既存の OP を再生成しても差分は出ません。

利用可能な feature-id は `maronn-oidc --help` で確認できます。

## 機能一覧

| feature-id | 機能 | 準拠仕様 | ドキュメント |
|---|---|---|---|
| `par` | Pushed Authorization Requests | RFC 9126 | [PAR](/maronn-oidc/experimental/par/) |
| `token-exchange` | OAuth 2.0 Token Exchange | RFC 8693 | [Token Exchange](/maronn-oidc/experimental/token-exchange/) |

## 問題の報告

Experimental 機能の不具合・仕様解釈の誤り・API への要望は、GitHub Issue で報告してください。

- <https://github.com/maronnjapan/maronn-oidc/issues>

報告時に次を含めてもらえると調査が早くなります。

- 使用した feature-id と `@maronn-oidc/experimental` のバージョン
- 生成に使ったコマンド（`--enable` / `--disable` の指定を含む）
- 期待した挙動と実際の挙動（可能なら HTTP のリクエスト / レスポンス）
- 根拠にした一次資料のセクション番号

API への要望は特に歓迎します。Experimental はフィードバックを受けて形を固めるための段階であり、寄せられた要望が安定版（core への昇格）の設計を決めます。
