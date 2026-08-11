---
"@maronn-openid-connect/cli": minor
---

`--enable token-exchange` で生成される OP が、Token Exchange の **delegation**（RFC 8693 §1.1 / §4.1）に対応しました。これまでは `actor_token` を含むリクエストを `invalid_request` で拒否していました。

impersonation（`actor_token` なし）は従来どおりで、生成されるトークンにも差分はありません。

## 生成コードの変更点

- `routes/token.ts`: 交換 grant の分岐が `processTokenExchangeRequest` の戻り値に含まれる `actor` を読み、delegation のときだけ `act` claim を **発行 JWT の payload とアクセストークン metadata の両方** に載せます。metadata へ保存するのは、そのトークンを後日 `subject_token` として再交換したときに委譲チェーンを繋げるためです（§4.1 のネスト）。ストア metadata の型は experimental が提供する構造的拡張型 `ExchangedAccessTokenInfo` を使います
- `conformance.test.ts`: delegation の契約テストを追加しました。`act` に actor が記録されること、impersonation では `act` が付かないこと、委譲済みトークンを再交換すると過去の actor が `act.act` へネストされること、delegation トークンでも UserInfo が subject を返すことを固定します。あわせて `actor_token` / `actor_token_type` の組み合わせ規則（§2.1）と、無効な `actor_token` の固定文言も検証します
  - この契約テストは、subject と actor の `sub` を区別するために 2 人目のシードユーザー `otheruser` で認可コードフローを流します。`authorizeFlow` / `subjectTokenFor` にユーザー名の引数が増えていますが、既定値は `testuser` のままなので既存テストの挙動は変わりません

`--enable token-exchange` を付けない生成物に差分はありません。

## 移行上の注意

- **`actor_token` を拒否する挙動に依存していた場合は影響があります。** 生成コードを再生成すると、有効な `actor_token` を伴うリクエストが 400 ではなく 200 を返すようになります。委譲を許可したくない場合は、`routes/token.ts` の交換分岐で `params.actor_token` を検証して拒否してください（分岐内のステップ関数は個別に呼べます）
- 再生成すると `routes/token.ts` と `conformance.test.ts` が更新されます
- `actor_token` は交換時点で有効なアクセストークンであることだけを確認し、**発行トークンの有効期間は cap しません**。寿命は従来どおり `min(config.accessTokenExpiresIn, subject_token の残存秒数)` で決まります
- Experimental です。API・設定値・生成コードの構造はマイナーリリースでも破壊的に変更されることがあります
