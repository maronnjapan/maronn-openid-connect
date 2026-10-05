---
"@maronn-openid-connect/core": minor
"@maronn-openid-connect/cli": minor
"@maronn-openid-connect/experimental": patch
"@maronn-openid-connect/google-login": patch
---

署名鍵を鍵の配列だけで扱い、配列の先頭の鍵で署名する

これまで `SigningKeyProvider` は、新しい署名に使う鍵を返す `getSigningKey()` と、JWKS で公開する鍵セットを返す任意の `getSigningKeys()` の 2 つを持っていた。`getSigningKeys()` は鍵ローテーションと複数アルゴリズム（RS256 + ES256）に対応するために後から足した任意メソッドで、実装しないプロバイダは `getRegisteredSigningKeys()` が `[await getSigningKey()]` にフォールバックしていた。生成コードもこれに合わせて単一鍵のコンテキスト（`privateKey` / `idTokenPrivateKey` / `userinfoPrivateKey` など）と鍵配列（`signingKeys` / `idTokenSigningKeys` / `userinfoSigningKeys`）を両方持ち、各ルートに「鍵配列が空なら単一鍵を使う」分岐があった。同じ鍵を 2 つの経路で表すため読みにくく、デバイスコードグラントや JARM が鍵配列ではなく単一鍵で署名してしまう不具合の原因にもなっていた。

鍵は配列だけで表し、役割は配列の順序で決める。

- 配列の先頭の鍵で新しいトークン（アクセストークンなど、alg を指定されない署名）に署名する
- 2 本目以降はローテーション済みの鍵や別アルゴリズムの鍵として JWKS で公開する。ID Token / UserInfo / JARM など alg が決まっている署名は、従来どおり `selectSigningKeyByAlg()` で鍵セットから alg に合う鍵を選ぶ
- ローテーションでは新しい鍵を先頭に置き、古い鍵はそれで署名したトークンが失効するまで後ろに残す

## 破壊的変更

- **core: `SigningKeyProvider` は `getSigningKeys(): Promise<SigningKey[]>` だけになった**。`getSigningKey()` は削除した
- **core: `getRegisteredSigningKeys()` を削除した**。`provider.getSigningKeys()` を直接呼ぶ
- **core: 鍵配列の並びを「古い → 新しい」から「新しい（署名に使う鍵）→ 古い」に変えた**。`selectSigningKeyByAlg()` は同じ alg の鍵が複数あるとき、末尾ではなく先頭に近い鍵を選ぶ
- **core: `createCachedSigningKeyProvider()` は `getSigningKeys()` だけをキャッシュする**
- **CLI 生成コード: リクエストコンテキストの単一鍵の変数を削除した**（`privateKey` / `publicJwk` / `keyId` / `idTokenPrivateKey` / `idTokenPublicJwk` / `idTokenKeyId` / `userinfoPrivateKey` / `userinfoPublicJwk` / `userinfoKeyId`）。鍵は `signingKeys` / `idTokenSigningKeys` / `userinfoSigningKeys` から読む
- **CLI 生成コード: 空の鍵配列を返すプロバイダを拒否する**。鍵の読み込み時に `validateSigningKeySet()` が例外にし、エンドポイントは 503（`Failed to load signing key`）を返す
- **CLI 生成コード（Next.js）: `SigningKeySet` を `{ active, registered }` から、先頭の鍵で署名する配列 `[SigningKey, ...SigningKey[]]` に変えた**。`keys.general.active` は `keys.general[0]` に、`keys.general.registered` は `keys.general` になる
- **CLI 生成コード: JWKS で kid の無い鍵を 1 本だけ公開するとき、末尾ではなく先頭（最新）の鍵を選ぶ**

## 移行方法

`getSigningKey()` を実装しているプロバイダは、署名に使う鍵を先頭にした配列を返す `getSigningKeys()` に置き換える。

```ts
// 変更前
const provider: SigningKeyProvider = {
  async getSigningKey() {
    return currentKey;
  },
  async getSigningKeys() {
    return [previousKey, currentKey];
  },
};

// 変更後
const provider: SigningKeyProvider = {
  async getSigningKeys() {
    return [currentKey, previousKey];
  },
};
```

CLI で生成したコードは再生成する。

experimental と google-login は core の minor リリースに合わせた同時リリースのみで、機能変更はない。
