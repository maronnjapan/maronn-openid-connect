# maronn-openid-connect から PR の作問を依頼する手順

このリポジトリでは、**作問を開始するボタンと、そのボタンが readRFCInMobile を操作するための鍵**を準備します。問題を作る処理・問題の公開先・PR にリンクを投稿するアプリの設定は readRFCInMobile 側で行います。

この手順を終えると、Actions の **Request a PR quiz** で PR 番号を入力して作問を依頼できます。生成された候補は readRFCInMobile で確認して公開します。

## 0. 先に readRFCInMobile を準備する

1. [readRFCInMobile の初期設定手順](https://github.com/maronnjapan/readRFCInMobile/blob/main/apps/quiz/docs/pr-integration.md)を開き、0〜10を順に実施します。Cloudflare と GitHub で作るもの、作成ボタン、取得する値、登録先を記載しています。
2. readRFCInMobile の画面から作問でき、作った問題を公開して解けることを確認します。
3. このリポジトリの main に [request-quiz.yml](https://github.com/maronnjapan/maronn-openid-connect/blob/main/.github/workflows/request-quiz.yml) があることを確認します。まだファイルがなければ、[追加 PR #195](https://github.com/maronnjapan/maronn-openid-connect/pull/195)の変更を main に反映します。

**AI 実行サーバーが未準備の場合は、起動用の鍵を作っても自動作問は動きません。** readRFCInMobile 側の[準備状況の確認と、AI サーバーを用意しない作問手順](https://github.com/maronnjapan/readRFCInMobile/blob/main/apps/quiz/docs/ai-executor-preparation.md)を先に確認します。

**完了の確認：** readRFCInMobile から最初の2問を作って公開できること。このリポジトリの main に起動用ファイルがあること。

## 1. このリポジトリに鍵の保存場所を作る

1. [maronn-openid-connect の Settings → Environments](https://github.com/maronnjapan/maronn-openid-connect/settings/environments)を開きます。
2. `quiz-authoring` があれば開きます。なければ **New environment** を押します。
3. 名前に `quiz-authoring` と入力し、**Configure environment** を押します。
4. **Environment secrets** 欄を確認します。次で作る鍵を、ここへ保存します。

Environment は、GitHub 上で設定をまとめて保存する場所です。readRFCInMobile にある同名の `quiz-authoring` とは別の場所です。

**完了の確認：** このリポジトリの Environments 一覧に `quiz-authoring` が表示されること。

## 2. readRFCInMobile の作問を起動する鍵を作る

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

## 4. 最初の作問を2問だけ依頼する

1. [Request a PR quiz](https://github.com/maronnjapan/maronn-openid-connect/actions/workflows/request-quiz.yml)を開きます。
2. **Run workflow** を押し、Branch は **main** を選びます。
3. 最初の確認では次の値を入力します。

| 入力欄 | 入れる値 |
| --- | --- |
| `pr_number` | `194` |
| `spec_id` | `rfc-6749` |
| `focus_paths` | `packages/core/src/client-credentials-grant.ts,packages/core/src/client-credentials-grant.test.ts` |
| `part` | `1` |
| `question_count` | `2` |
| `question_categories` | `knowledge,debugging` |

4. **Run workflow** で実行します。
5. 新しい実行を開きます。Environment の既存ルールにより承認待ちになった場合は **Review deployments** から承認します。
6. 成功したら Summary の **readRFCInMobile の実行・生成候補を確認する** を開きます。
7. 移動先で **Author or publish a quiz (manual)** の新しい実行を開きます。入力条件が今の依頼と一致することを確認します。
8. 作問が成功するまで待ち、Summary の **候補を見る** を開きます。

maronn-openid-connect の処理の成功は「作問の依頼を送れた」という意味です。readRFCInMobile で候補が作成されるところまで確認して、この節の完了とします。

**完了の確認：** readRFCInMobile に、PR #194 を題材にした2問の候補が保存されること。

## 5. 確認して公開し、元の PR から問題を開く

1. [readRFCInMobile の手順9](https://github.com/maronnjapan/readRFCInMobile/blob/main/apps/quiz/docs/pr-integration.md#9-問題を確認して公開する版を保存する)に従い、候補の問題文・正解・解説を確認します。
2. 同手順でファイルの `status` を `published` に変更して保存します。
3. [同手順10](https://github.com/maronnjapan/readRFCInMobile/blob/main/apps/quiz/docs/pr-integration.md#10-問題を公開して回答と-pr-のリンクを確認する)で、変更後の40文字のコミット番号と問題ファイルのパスを使って公開します。
4. [対象の PR #194](https://github.com/maronnjapan/maronn-openid-connect/pull/194)を開きます。
5. Conversation に問題へのリンクがあり、Checks に「仕様理解クイズ」が表示されることを確認します。
6. リンクをプライベートウィンドウで開き、ログインせず回答できることを確認します。

GitHub App の作成・インストール・投稿権限は readRFCInMobile 側の初期設定手順5で設定します。このリポジトリへ問題 JSON をコピーする必要はありません。

**完了の確認：** このリポジトリの PR から、公開された問題へ移動して回答できること。

## 6. 次からの依頼方法

4と同じ画面で `pr_number` を変えて依頼します。

| 変えたいこと | 操作 |
| --- | --- |
| PR の変更内容だけを出題する | `spec_id` を空欄にする |
| 仕様と照合する | `spec_id` に `rfc-6749`・`oidc-core-1_0` など、readRFCInMobile に登録された ID を入れる |
| 特定のファイルだけを問う | `focus_paths` にファイルパスを入れる。複数ならカンマ区切り |
| ディレクトリ全体を対象にする | `focus_paths` に `packages/core/src/` などを入れる。末尾の `/` が必要 |
| 対象の変更が8ファイルを超える | `part=1`、次は `part=2` として分けて依頼する |
| 問題数を増やす | `question_count` を2〜10で指定。カテゴリの数以上にする |

公開は毎回、readRFCInMobile で確認してから行います。PR の作成・更新だけでは自動で作問しません。

## 困ったとき

| 表示・症状 | 確認する場所 |
| --- | --- |
| Request a PR quiz が見当たらない | main に `request-quiz.yml` があるか。0-3を確認 |
| `Set QUIZ_DISPATCH_TOKEN` と出る | **このリポジトリの** quiz-authoring → Environment secrets に名前が完全一致しているか |
| 起動の依頼が403または404で失敗 | トークンの期限、対象が readRFCInMobile か、Actions が Read and write か、readRFCInMobile の main に `quiz-authoring.yml` があるか |
| 実行がスキップされる | Run workflow で Branch に main を選んだか |
| 依頼は成功したが問題が見つからない | Summary のリンク先の readRFCInMobile で、作問処理の結果を確認 |
| readRFCInMobile 側が失敗 | 同リポジトリの[手順書の「困ったとき」](https://github.com/maronnjapan/readRFCInMobile/blob/main/apps/quiz/docs/pr-integration.md#困ったときに確認する場所)を確認 |
| 公開したが PR にリンクがない | readRFCInMobile 側の GitHub App の設定と、設定を問題アプリへ反映する公開処理が済んでいるか |

パソコンで依頼内容だけを確認する場合は、リポジトリのルートから次を実行します。`--dry-run` がある間は作問を起動しません。

```sh
PR_NUMBER=194 SPEC_ID=rfc-6749 FOCUS_PATHS=packages/core/src/ node .github/scripts/request-quiz.mjs --dry-run
```
