---
---

関数の本体を字句解析で処理の流れにする読み取り（`extract/function-flow.ts`、`FunctionProject.flowOf` と、resolver や store の変数名からインターフェースのメンバーを推し量る `describeMember` / `memberOf` / `memberById`）を CLI から外す。使っていたのはリポジトリの地図（`apps/map`）のビルドだけで、地図は TypeScript のコンパイラで木を読む `packages/map-analysis` に移った。カタログが呼び出しと本体を読むためのトークナイザは `extract/tokens.ts` に残す。CLI のコマンドと生成コードは変わらないのでリリースしない。
