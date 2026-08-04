---
title: Introduction
description: What is Maronn OIDC and when to use it.
---

## What is Maronn OIDC?

Maronn OIDC は、OpenID Connect Core 1.0 と OAuth 2.1 に準拠した軽量なプロバイダーライブラリです。

PoC開発者が「自分の要件がこの仕様で実現できるか？」を素早く検証するためのブリッジを提供します。検証が完了したら、本格的な IdaaS や OSS へ移行していくユースケースを想定しています。

## Why not Keycloak or Auth0?

| | Maronn OIDC | Keycloak | Auth0 |
|---|---|---|---|
| セットアップ | 数分 | 数時間〜 | SaaS設定が必要 |
| 依存関係 | ゼロ (production) | 重厚 | クラウド依存 |
| カスタマイズ | コード直接変更 | 設定 + SPI | 限定的 |
| 目的 | PoC・仕様検証 | 本番運用 | 本番運用 |

## Supported Specifications

- **OpenID Connect Core 1.0** — Authorization Code Flow、UserInfo、`prompt` / `max_age` / `claims` パラメータ、Request Object（§6.1）
- **OpenID Connect Discovery 1.0** — Provider Metadata / JWKS
- **OAuth 2.1** — PKCE（S256）必須、refresh token rotation + absolute lifetime
- **RFC 7662** — Token Introspection
- **RFC 7009** — Token Revocation
- **RFC 9068** — JWT Access Token（`jwt` 形式選択時）

機能の詳細は [Features](../reference/features/) を参照してください。

## How to Use

利用者の入口は CLI です。CLI でフロー実装コードを生成し、そのコードを改造しながら仕様を検証します。

1. `maronn-oidc generate <framework>` で OP 実装コード一式を生成する
2. 署名鍵・クライアント情報などを注入して起動する
3. 生成コードを改造しながら要件を検証する（契約テスト `conformance.test.ts` が想定挙動からの逸脱を検知）

## Architecture

このライブラリはモノレポ構成で、コアパッケージ、CLI、CLI生成コードを検証するサンプルで構成されています。

### `@maronn-openid-connect/core`

OpenID Connect Providerのコアロジックを実装するパッケージです。認可リクエスト検証、トークン発行、UserInfo、Discovery などの純関数を提供し、HTTP 配線とストレージは resolver / store として利用者が注入します。高度な組み込みユースケース向けのロジック層として使用できます。

### `@maronn-openid-connect/cli`

対象プロジェクトに Authorization Code Flow を実装した OP コード一式を生成する CLI ツールです。Hono / Express / Fastify / Next.js に対応し、`--enable` / `--disable` で機能構成を選択できます。
