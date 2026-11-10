---
---

テスト用 helper の `expect` を各テスト本体へ移し、配置の lint と実装・レビュー skill を更新する。`packages/google-login/src/test-helpers.ts` は tsconfig で出荷物から除外しているテスト用コードであり、公開 API・生成する Provider・実行時の振る舞いは変わらないため、リリースは不要。
