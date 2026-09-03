---
"@maronn-openid-connect/cli": minor
---

`--scope` で、生成 OP が受け付けるカスタムスコープを生成時に宣言できるようにする。宣言すると `scopes.ts`（スコープポリシー）が生成され、discovery の `scopes_supported` に宣言したスコープが載り、認可エンドポイント（`--enable device-authorization-grant` / `--enable ciba` を併用した場合はデバイス認可・バックチャネル認証エンドポイントも）は宣言していないスコープ値を `invalid_scope` で拒否するようになる。このチェックは `applyOfflineAccessPolicy` の後に置き、付与条件を満たさない `offline_access` を「無視する」挙動（OIDC Core 1.0 §11）を壊さない。

「誰にどのスコープを許すか」は CLI のオプションにせず、生成コード側に置いた。`scopes.ts` の `resolveGrantableScopes()`（async。手早く絞るための `RESTRICTED_SCOPE_SUBJECTS` 付き）が絞り込みの入口で、同意画面の表示と承認、SSO fast path と `prompt=none`、device / CIBA の承認からすでに `await` された状態で生成される。SSO と `prompt=none` では保存済み同意を引く前に適用するため、そのユーザーが持てないスコープをキーに同意を探し続けることがない。落としたスコープはリクエストを失敗させず付与スコープを狭める（RFC 6749 §3.3。トークンレスポンスの `scope` に実際の付与内容が載る）。宣言が 1 つも無い場合は何も生成せず、生成出力は従来とバイト同一。
