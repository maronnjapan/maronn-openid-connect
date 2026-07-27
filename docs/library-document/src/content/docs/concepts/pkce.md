---
title: PKCE
description: Proof Key for Code Exchange — required for all clients in OAuth 2.1.
---

PKCE (Proof Key for Code Exchange) は、認可コードの横取り攻撃を防ぐための仕組みです。OAuth 2.1 ではすべてのクライアントに対して PKCE が必須です。

## How PKCE Works

1. クライアントがランダムな `code_verifier` を生成する
2. `code_verifier` を SHA-256 でハッシュし、Base64URL エンコードして `code_challenge` を作成する
3. 認可リクエストに `code_challenge` と `code_challenge_method=S256` を含める
4. トークンリクエストに `code_verifier` を含める
5. サーバー側で `code_verifier` から `code_challenge` を再計算して検証する

## S256 Transformation

```
code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))
```

`code_verifier` の要件（RFC 7636）:
- 文字セット: `[A-Z] / [a-z] / [0-9] / "-" / "." / "_" / "~"`
- 長さ: 43〜128文字

## Client-Side Example

```typescript
// 1. code_verifier を生成
const array = new Uint8Array(32);
crypto.getRandomValues(array);
const codeVerifier = btoa(String.fromCharCode(...array))
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=/g, '');

// 2. code_challenge を生成 (S256)
const encoder = new TextEncoder();
const data = encoder.encode(codeVerifier);
const hash = await crypto.subtle.digest('SHA-256', data);
const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=/g, '');

// 3. 認可リクエストに含める
const authUrl = new URL('https://provider.example.com/authorize');
authUrl.searchParams.set('code_challenge', codeChallenge);
authUrl.searchParams.set('code_challenge_method', 'S256');
// ... 他のパラメーター
```

## Server-Side Validation

このライブラリはトークンエンドポイントの `verifyAuthorizationCodePkce` ステップで PKCE を検証します（後方互換の `validateAuthorizationCodeGrant` も内部で同ステップを呼びます）。保存された `code_challenge` に対して `BASE64URL(SHA256(code_verifier))` を再計算して比較し、不一致の場合は `invalid_grant` エラーを返します。

対応する `code_challenge_method` は `S256` のみです（`plain` は拒否）。

既定では PKCE は必須ですが、CLI の `--disable pkce`（`allowNonPkceAuthorizationCodeFlow: true`）で、明示的な confidential client の完全な非 PKCE リクエストのみ許可する互換モードにできます。この場合も public client や不正な PKCE 値は拒否されます。

## References

- [RFC 7636 — Proof Key for Code Exchange](https://datatracker.ietf.org/doc/html/rfc7636)
- [OAuth 2.1 Section 4.1.1](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1) — PKCE 必須化
