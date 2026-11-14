# maronn-openid-connect から PR の作問資料を渡す手順

このリポジトリは PR 番号・対象仕様・対象パスなどの情報を readRFCInMobile に渡す役割です。受信側は情報を作問資料として保存します。資料から問題を作る作業は、ローカルの Claude Code・手作業・任意の AI API などで別途行います。完成済みの問題 JSON を readRFCInMobile に反映すると公開・回答でき、元の PR に回答 URL を返せます。

この手順を終えると、Actions の **Request PR quiz materials** で PR 情報を送り、作問資料を保存できます。この送信・資料保存では AI を実行しません。ログイン後の記述式の AI 採点は、問題アプリに残る独立した機能です。

## 0. 先に readRFCInMobile を準備する

1. [readRFCInMobile の PR 連携手順](https://github.com/maronnjapan/readRFCInMobile/blob/main/apps/quiz/docs/pr-integration.md)を開き、資料保存用の Workflow が main にあることを確認します。
2. 資料保存と、作成済み問題 JSON の公開・回答は AI 作問 API がなくても利用できます。問題アプリの公開や PR リンク返却の設定は readRFCInMobile 側で行います。
3. このリポジトリの main に [request-quiz.yml](https://github.com/maronnjapan/maronn-openid-connect/blob/main/.github/workflows/request-quiz.yml) があることを確認します。まだファイルがなければ、[追加 PR #195](https://github.com/maronnjapan/maronn-openid-connect/pull/195)の変更を main に反映します。

AI 作問サーバーの準備は任意です。手動の AI 作問を使う場合だけ、受信側の独立した AI Workflow を利用します。

**完了の確認：** readRFCInMobile に資料保存用の Workflow、このリポジトリの main に送信用ファイルがあること。

## 1. このリポジトリに鍵の保存場所を作る

1. [maronn-openid-connect の Settings → Environments](https://github.com/maronnjapan/maronn-openid-connect/settings/environments)を開きます。
2. `quiz-authoring` があれば開きます。なければ **New environment** を押します。
3. 名前に `quiz-authoring` と入力し、**Configure environment** を押します。
4. **Environment secrets** 欄を確認します。次で作る鍵を、ここへ保存します。

Environment は、GitHub 上で設定をまとめて保存する場所です。readRFCInMobile にある同名の `quiz-authoring` とは別の場所です。

**完了の確認：** このリポジトリの Environments 一覧に `quiz-authoring` が表示されること。

## 2. readRFCInMobile の資料保存を依頼する鍵を作る

1. [GitHub の Fine-grained personal access tokens の作成画面](https://github.com/settings/personal-access-tokens/new)を開きます。これはリポジトリの設定ではなく、自分のアカウントの設定です。
2. 次のとおり設定します。

| 画面の項目 | 選ぶ・入力する値 |
| --- | --- |
| Token name | `start-readrfc-quiz` |
| Resource owner | `maronnjapan` |
| Expiration | 有効期限を選ぶ。期限が来たら同じ手順で作り直して3の Secret を更新する |
| Repository access | **Only select repositories** |
| Selected repositories | **readRFCInMobile**。操作される側を選ぶ |
| Permissions → Repository permissions → Actions | **Read and write** |
| Metadata | 自動で付く Read-only のまま |

3. **Generate token** を押します。
4. 表示されたトークンの全文をコピーします。`github_pat_...` のような値です。全文を表示できるのはこのときだけなので、そのまま3の登録へ進みます。

この鍵は「readRFCInMobile の Actions を起動する」ためのものです。Cloudflare の作問用の鍵、Claude の API キー、PR へ投稿する GitHub App の秘密鍵を入れる欄ではありません。

**完了の確認：** 対象が readRFCInMobile、権限が Actions の Read and write になっていること。トークンの全文をコピーできていること。

## 3. 作った鍵を maronn-openid-connect に保存する

1. **maronn-openid-connect → Settings → Environments → quiz-authoring** に戻ります。
2. **Environment secrets → Add environment secret** を押します。
3. Name に `QUIZ_DISPATCH_TOKEN` を入力します。
4. Value に2でコピーしたトークンの全文を貼り付けます。
5. **Add secret** を押します。

保存先はこのリポジトリです。トークンの操作対象は readRFCInMobile ですが、呼び出す側の maronn-openid-connect がその鍵を使います。

**完了の確認：** Environment secrets に `QUIZ_DISPATCH_TOKEN` の名前が表示されること。保存後に値が見えないのは正常です。

## 4. PR 情報を送り、作問資料を保存する

1. [Request PR quiz materials](https://github.com/maronnjapan/maronn-openid-connect/actions/workflows/request-quiz.yml)を開きます。
2. **Run workflow** を押し、Branch は **main** を選びます。
3. 最初の確認では次の値を入力します。

| 入力欄 | 入れる値 |
| --- | --- |
| `pr_number` | `194` |
| `spec_id` | `rfc-6749` |
| `focus_paths` | `packages/core/src/client-credentials-grant.ts,packages/core/src/client-credentials-grant.test.ts` |
| `question_count` | `2` |
| `question_categories` | `knowledge,debugging` |

4. **Run workflow** で実行します。
5. 新しい実行を開きます。Environment の既存ルールにより承認待ちになった場合は **Review deployments** から承認します。
6. 成功したら Summary の **readRFCInMobile の実行・作問資料を確認する** を開きます。
7. 移動先で **Prepare quiz materials or publish a quiz** の新しい実行を開きます。入力条件が今の依頼と一致することを確認します。
8. 資料保存が成功するまで待ち、Summary の **資料を見る** を開きます。PR 本文・議論・変更一覧・変更前後コードなどが保存されています。

maronn-openid-connect の処理の成功は「情報を送り、資料保存を依頼できた」という意味です。受信側の資料が保存されたところまで確認します。問題数・カテゴリの入力は作問メモで、問題生成は開始しません。

**完了の確認：** readRFCInMobile の quiz/materials-<run>-<attempt> ブランチに PR #194 の作問資料 JSON が保存されること。

## 5. 問題を別途作成して公開し、元の PR から開く

1. 保存された資料を読み、ローカルの Claude Code・手作業・任意の AI API などで、readRFCInMobile の形式に合う問題 JSON を作ります。
2. [問題ファイルだけで公開する手順](https://github.com/maronnjapan/readRFCInMobile/blob/main/apps/quiz/docs/question-files.md)に従って形式と内容を確認し、status を published にします。
3. 問題 JSON を readRFCInMobile の main に反映してデプロイするか、別ブランチへコミット・push して固定 SHA とパスを指定した publish を実行します。
4. [対象の PR #194](https://github.com/maronnjapan/maronn-openid-connect/pull/194)を開きます。
5. Conversation に問題へのリンクがあり、Checks に「仕様理解クイズ」が表示されることを確認します。
6. リンクをプライベートウィンドウで開き、ログインせず回答できることを確認します。

GitHub App の作成・インストール・投稿権限は readRFCInMobile 側の PR 連携手順に従って設定します。このリポジトリへ問題 JSON をコピーする必要はありません。

**完了の確認：** このリポジトリの PR から、公開された問題へ移動して回答できること。

## 6. 次からの依頼方法

4と同じ画面で `pr_number` を変えて依頼します。

| 変えたいこと | 操作 |
| --- | --- |
| PR の変更内容だけを出題する | `spec_id` を空欄にする |
| 仕様と照合する | `spec_id` に `rfc-6749`・`oidc-core-1_0` など、readRFCInMobile に登録された ID を入れる |
| 特定のファイルだけを問う | `focus_paths` にファイルパスを入れる。複数ならカンマ区切り |
| ディレクトリ全体を対象にする | `focus_paths` に `packages/core/src/` などを入れる。末尾の `/` が必要 |
| 対象の変更ファイルが多い | 既定で全変更ファイルを取得する。必要なら focus_paths で任意に絞る |
| 作問する人・ツールへ希望を伝える | question_count・question_categories を作問メモとして指定。問題数の独自上限はない |

作問は情報送信と分離して行います。PR の作成・更新やこの Workflow の送信だけでは、AI 作問を開始しません。

## 困ったとき

| 表示・症状 | 確認する場所 |
| --- | --- |
| Request PR quiz materials が見当たらない | main に `request-quiz.yml` があるか。0-3を確認 |
| `Set QUIZ_DISPATCH_TOKEN` と出る | **このリポジトリの** quiz-authoring → Environment secrets に名前が完全一致しているか |
| 起動の依頼が403または404で失敗 | トークンの期限、対象が readRFCInMobile か、Actions が Read and write か、readRFCInMobile の main に `quiz-authoring.yml` があるか |
| 実行がスキップされる | Run workflow で Branch に main を選んだか |
| 依頼は成功したが問題が見つからない | Summary のリンク先で資料保存の結果を確認。その資料から問題を別途作成・公開する |
| readRFCInMobile 側が失敗 | 同リポジトリの[PR 連携手順](https://github.com/maronnjapan/readRFCInMobile/blob/main/apps/quiz/docs/pr-integration.md)を確認 |
| 公開したが PR にリンクがない | readRFCInMobile 側の GitHub App の設定と、設定を問題アプリへ反映する公開処理が済んでいるか |

パソコンで依頼内容だけを確認する場合は、リポジトリのルートから次を実行します。`--dry-run` がある間は依頼を送信しません。

```sh
PR_NUMBER=194 SPEC_ID=rfc-6749 FOCUS_PATHS=packages/core/src/ node .github/scripts/request-quiz.mjs --dry-run
```
