# Changesets

このディレクトリは [Changesets](https://github.com/changesets/changesets) が管理する。
変更内容とバージョン上げ方針（major / minor / patch）を記録するための仕組み。

## 使い方

変更を加えたら、リリース対象パッケージの変更を記録する changeset を作成する:

```bash
pnpm changeset
```

対象パッケージと semver の種類（major / minor / patch）を選び、変更概要を書く。
`.changeset/*.md` が生成されるので、これを通常のコミットに含めて push する。

`main` に push されると Release ワークフロー（`.github/workflows/release.yml`）が
未消化の changeset をまとめた "Version Packages" PR を自動作成する。
その PR をマージすると、バージョンと CHANGELOG が確定し、npm へ publish される。

publish は npm Trusted Publishing (OIDC) を利用するため、`NPM_TOKEN` などの長期トークンは不要。
詳細は `.github/workflows/release.yml` 冒頭のコメントを参照。

## `@maronn-openid-connect/experimental` は changeset を書かなくてよい

`packages/experimental/src` の実装を変更した場合、changeset を手で書く必要はない。
main への push で CI が `auto-experimental-patch.md`（bump は常に `patch`）を自動生成する。

- bump は**どんな変更でも patch を 1 つ上げるだけ**に固定している。`pnpm changeset` で
  experimental を minor / major に指定すると CI（`pnpm run test:release-contract`）が落ちる。
- 自動生成される changeset は常に 1 本で、未リリースの変更がたまっても patch 1 回に吸収される。
- 実装ではなく README や package.json だけを変更したときは自動生成の対象外なので、
  publish したい場合は `pnpm changeset` で patch の changeset を手で追加する。

詳細は `RELEASE.md` の「experimental の自動 publish」を参照。

なお、自動生成される `auto-experimental-patch.md` は CI の実行中にだけ作られるファイルで、
main にコミットされることはない（Version Packages PR の中で消費されて消える）。
