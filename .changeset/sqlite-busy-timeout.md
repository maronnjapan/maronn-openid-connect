---
"@maronn-oidc/cli": patch
---

Next.js 生成コードの SQLite ストレージバックエンドに `PRAGMA busy_timeout` を設定し、`next build` のページデータ収集など複数プロセスが同一ファイルへ同時アクセスした際に `SQLITE_BUSY`（database is locked）で即座に失敗せず待機できるようにした。
