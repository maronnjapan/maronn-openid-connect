# 鍵を使わない入力に不要な loader を要求しない

## parseRequestObject <!-- core:request-object.ts#parseRequestObject -->

許可された `alg: "none"` には鍵が不要なので、`loadJwks` は optional のまま保つ。署名付きの入力では loader の省略も空の鍵集合も同じ拒否として扱い、候補の絞込みには常に配列を渡す。

`kid` の有無によって鍵未指定時のエラーが変わらないようにする。既存の拒否を TypeError と取り違えず、公開 API の必須化による不要な変更を避ける。
