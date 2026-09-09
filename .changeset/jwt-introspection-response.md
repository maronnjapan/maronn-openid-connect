---
"@maronn-openid-connect/cli": minor
---

`--enable jwt-introspection-response` で JWT Response for OAuth Token Introspection（RFC 9701）を生成できるようにする。イントロスペクションエンドポイントは、`Accept: application/token-introspection+jwt` を明示したリクエストに対してのみ、RFC 7662 の応答を `token_introspection` クレームへ封入し `typ: token-introspection+jwt`・RS256 で署名した JWT で返す。JWT 応答の経路には RFC 9701 §3 の呼び出し元 audience 制限（発行先本人または `aud` 記載先以外には `{"active": false}`）を適用し、discovery に `introspection_signing_alg_values_supported: ["RS256"]` を広告する。`Accept` を明示しないリクエストへの JSON 応答と、未選択時の生成出力は従来とバイト同一。`--disable introspection` との併用は生成時にエラーとして拒否する。experimental には subpath export `@maronn-openid-connect/experimental/jwt-introspection-response`（Accept 判定・audience 制限・応答 JWT 生成）が加わる。
