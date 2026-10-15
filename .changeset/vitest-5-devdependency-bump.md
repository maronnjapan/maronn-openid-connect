---
---

vitest を 5.0.3 へ更新する（Dependabot #126）。テスト実行にしか使わない devDependency の更新で、npm 出荷物（dist と型定義）は変わらないためリリースは不要と判断した。

ルートの `pnpm.overrides.vitest` は workspace 全体でバージョンを揃えるためのピンなので、devDependency 側の指定に合わせて `5.0.3` へ更新している。このピンを 4.1.11 のまま残すと lockfile の overrides と設定が食い違い、`pnpm install --frozen-lockfile` が `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` で落ちる。
