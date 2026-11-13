# PR の変更内容を問題にする

このリポジトリの PR を題材に、[readRFCInMobile](https://github.com/maronnjapan/readRFCInMobile) でスマホ向けの理解度確認問題を作成できる。

## 一度だけ行う設定

1. readRFCInMobile 側の PR 連携実装を main に反映し、Worker をデプロイする。
2. 同リポジトリの `quiz-authoring` Environment に出題 API の URL と作問用 Access Service Token を設定する。Worker の許可リポジトリに `maronnjapan/maronn-openid-connect` を追加し、PR コメント・Check 用の GitHub App をこのリポジトリへインストールする。
3. このリポジトリに `quiz-authoring` Environment を作成し、Secret `QUIZ_DISPATCH_TOKEN` を設定する。readRFCInMobile だけを対象に Actions: write を持つ fine-grained PAT、または同等のインストールトークンを使う。

設定名・権限・公開手順の正本は [readRFCInMobile の接続手順](https://github.com/maronnjapan/readRFCInMobile/blob/main/apps/quiz/docs/pr-integration.md)。この Workflow は作問の起動だけを依頼し、Access の認証情報・AI のキー・公開権限を扱わない。

## 作問を依頼する

Actions → **Request a PR quiz** → Run workflow で main を選ぶ。

| 入力 | 内容 |
| --- | --- |
| `pr_number` | このリポジトリの PR 番号 |
| `spec_id` | 空欄なら PR の変更内容だけを問う。仕様と照合するなら `rfc-6749`・`oidc-core-1_0` など、受け側に登録された ID |
| `focus_paths` | ファイル・ディレクトリのカンマ区切り。ディレクトリは末尾 `/`。空欄なら許可された範囲の変更を取得 |
| `part` | パス順で8変更ファイルずつ分けた番号。既定1 |
| `question_count` | 2〜10問。既定7 |
| `question_categories` | カンマ区切り。既定は全7カテゴリ。問題数はカテゴリ数以上にする |

たとえば PR #194 の client_credentials は `spec_id=rfc-6749`、`focus_paths=packages/core/src/client-credentials-grant.ts,packages/core/src/client-credentials-grant.test.ts` として作問できる。

依頼が受理されると Summary に readRFCInMobile の実行一覧へのリンクが表示される。受け側の `quiz-authoring` Environment の設定に従って作問が始まり、結果は readRFCInMobile の専用ブランチへ draft として保存される。依頼 Workflow の成功は起動の受付を表す。作問結果はリンク先で確認する。

生成候補をレビューし、readRFCInMobile 側で固定コミットを公開すると、この PR のコメントと neutral Check に問題へのリンクが載る。PR の作成・更新だけでは作問を開始しない。コード・テスト・変更メモの内容は取得資料として読み、対象 PR のコードを権限付きで実行することはない。

PR 本文、レビュー、変更メモには、その変更の理由と確認したケースを書くと出題の根拠になる。変更メモを題材にする場合は `focus_paths` に対象ファイルを含める。

ローカルで依頼内容だけを確認する場合:

```sh
PR_NUMBER=194 SPEC_ID=rfc-6749 FOCUS_PATHS=packages/core/src/ node .github/scripts/request-quiz.mjs --dry-run
node --test .github/scripts/request-quiz.test.mjs
```

実際に依頼する場合は `QUIZ_DISPATCH_TOKEN` を環境変数へ設定し、`--dry-run` を外す。HTTP `403/404` はトークンの対象リポジトリ・Actions 権限と、受け側 Workflow が main に反映済みかを確認する。
