---
---

vitest を 4.1.11 へ更新する（Dependabot #66）。テスト実行にしか使わない devDependency の更新で、npm 出荷物（dist と型定義）は変わらないためリリースは不要と判断した。

ルートの `pnpm.overrides.vitest` は workspace 全体でバージョンを揃えるためのピンなので、devDependency 側の指定に合わせて `4.1.11` へ更新している。このピンを 3.2.6 のまま残すと override が新しい指定を打ち消し、lockfile と設定が食い違って `pnpm install --frozen-lockfile` が `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` で落ちる。
