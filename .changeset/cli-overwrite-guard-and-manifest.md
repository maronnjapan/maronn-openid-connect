---
'@maronn-openid-connect/cli': minor
---

generate / setup に上書きガードを追加する。出力先に既存の生成対象ファイルがある場合は何も書き込まずに一覧を表示して非ゼロ終了し、`--force` 指定時のみ上書きする（ログは `Created:` / `Overwritten:` で区別）。`--dry-run` で出力予定の一覧だけを確認できる。また、生成物に `.maronn-openid-connect.json` マニフェストを追加し、生成元の CLI バージョン・framework・機能構成・カスタムスコープを記録する。
