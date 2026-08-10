---
"@maronn-openid-connect/core": minor
"@maronn-openid-connect/cli": patch
---

Essential な `acr` クレーム要求を満たせないときに ID Token を発行しないようになりました（OpenID Connect Core 1.0 §5.5.1.1）。

これまでは `claims={"id_token":{"acr":{"essential":true,"values":[...]}}}` を受け取っても、`AcrResolver` が要求外の `acr` を返した場合や `undefined` を返した場合に、要求を満たさないまま ID Token が発行されていました（`essential` はパースされるだけで参照されていませんでした）。RP が `acr` の欠落を厳格に検査していないと、要求した認証強度を満たさないセッションをそのまま受け入れてしまう状態でした。

§5.5.1.1 は「Essential な `acr` 要求を満たせない場合は認証失敗として扱わなければならない」と規定しています。§5.5.1 の「Claim を返せなくてもエラーにしてはならない」という一般則には `unless otherwise specified in the description of the specific claim` という但し書きがあり、`acr` はその例外にあたります。

- `resolveAcrAmr` は、Essential な `acr` 要求（`essential: true` かつ `value` または `values` あり）が満たされない場合に `invalid_grant` の `TokenError` を投げます。生成 OP の token ルートは既存の catch でこれを `Cache-Control: no-store` 付きのエラーレスポンスへ変換します
- `value`（単数）も `values`（配列）と同じく要求値として扱うようになりました
- Essential 要求の要求値は、`acr_values` パラメータより優先して `AcrResolver` へ渡されます（`acr_values` は §3.1.2.1 の Note により Voluntary な要求のため）
- `essential` 省略 / `essential: false` の要求、および `acr_values` パラメータのみによる要求は従来どおりで、値が一致しなくてもエラーになりません
- refresh_token grant が §12.1 に従って保存済みの `acr` / `amr` を直接渡す経路は影響を受けません

`claims` パラメータで `acr` を Essential 要求していない利用者に差分はありません。Essential 要求を受け取る OP では、`AcrResolver` が要求値のいずれかを返せる実装になっているか確認してください。
