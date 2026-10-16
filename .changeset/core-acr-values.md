---
'@maronn-openid-connect/core': minor
'@maronn-openid-connect/experimental': patch
'@maronn-openid-connect/google-login': patch
---

認可リクエストの `acr_values` を検証するステップ関数を追加し、アクセストークンとイントロスペクションで `acr` を扱えるようにする

- ステップ関数 `validateAcrValuesParameter()` を追加した。`acr_values`（OIDC Core 1.0 §3.1.2.1）は省略してよく、空文字と空白だけの値は省略として扱う。空白区切りの各値が RFC 6749 §3.3 の scope-token と同じ文字（`"` と `\` を除く、表示できる ASCII 文字）だけでできていなければ `invalid_request`（redirectable）で拒否し、通れば優先順を保ったまま 1 つの空白で連結し直した値を返す。値を分ける `parseAcrValues()` と、各値の構文を検査する `validateAcrValues()` も個別に呼べる
- 要求された acr 値のうち最も優先する値（先頭の値）を返す `selectPreferredAcr()` を追加した。AcrResolver を使わずに、要求された値を acr にするときに使う
- `buildAccessTokenPayload()` の入力に `acr` を追加した。指定すると、アクセストークンの payload に `acr` クレーム（RFC 9068 §2.2.1）が入る。`AccessTokenPayload` にも `acr` を足した
- `AccessTokenInfo.acr` を追加した。`buildIntrospectionResponse()` は、アクセストークンに保存された `acr` をレスポンスに含める（RFC 9470 §6.2）

experimental と google-login は core の minor リリースに合わせた同時リリースのみで、機能変更はない。
