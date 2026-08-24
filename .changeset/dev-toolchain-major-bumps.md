---

---

開発ツールチェーンのメジャーバージョンを引き上げた（出荷物の変更なし）

TypeScript 5.7 → 7.0 / vitest 3（core は 2）→ 4 / esbuild 0.25 → 0.28 / fastify 5.6 → 5.12 /
@changesets/cli 2 → 3 / changesets/action v1 → v2。いずれも devDependency と CI の更新で、
publish されるパッケージの実装は変えていない。

TypeScript 7 では tsc の出力が変わらないことを確認したうえで上げている（packages/core の
emit を 5.7.2 と突き合わせ、`.js` は全ファイル一致、`.d.ts` の差分は文字列リテラルの
クォート記法のみ）。そのため semver 上の bump は不要で、この changeset は空にしている。
