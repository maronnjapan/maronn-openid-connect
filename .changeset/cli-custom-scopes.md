---
"@maronn-openid-connect/cli": minor
---

`--scope` と `--user-scope` で、生成 OP が受け付けるカスタムスコープを生成時に宣言できるようにする。`--scope reports.read` は認証したどの End-User にも付与され、`--user-scope alice:admin.write` は宣言した subject にだけ付与される（対象外の End-User の付与スコープからは落とす。RFC 6749 §3.3 は要求より狭いスコープの発行を認めており、トークンレスポンスの `scope` に実際の付与内容が載る）。宣言すると、ポリシーモジュール `scopes.ts`（`findUnsupportedScopes()` / `resolveGrantableScopes()` の 2 関数だけを持ち、何も import しないので DB 参照へ差し替えられる）が生成され、discovery の `scopes_supported` に宣言したスコープが載り、認可エンドポイントは宣言していないスコープ値を `invalid_scope` で拒否するようになる。`--enable device-authorization-grant` / `--enable ciba` を併用した場合はそれぞれのリクエストエンドポイントと承認ステップにも同じポリシーが適用される。宣言が 1 つも無い場合は何も生成せず、生成出力は従来とバイト同一。
