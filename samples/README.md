# samples/*

`packages/cli` が生成する OpenID Provider コードを、実フレームワークおよび実インフラで動作確認するための内部検証用サンプル集です。
利用者が直接触るものではありません（ルートの `README.md` を参照）。

## 命名規則

ディレクトリ名は **「フレームワーク-デプロイ想定環境」** の形式で命名する。どこへデプロイして検証する想定のサンプルかが名前だけで分かるようにするため。新しいサンプルを追加する場合もこの規則に従うこと。

| サンプル | フレームワーク | デプロイ先 | ローカルストレージ | デプロイ時ストレージ |
|---|---|---|---|---|
| `hono-cloudflare` | Hono | Cloudflare Workers | D1（Wranglerエミュレート） | D1 |
| `express-flyio` | Express | Fly.io | node:sqlite | node:sqlite + 永続ボリューム |
| `fastify-flyio` | Fastify | Fly.io | node:sqlite | node:sqlite + 永続ボリューム |
| `nextjs-vercel` | Next.js | Vercel | node:sqlite | Upstash Redis REST |

## 一発コマンド

すべてリポジトリルートから実行する。クローン直後でもそのまま動く（依存インストール・ビルド込み）。

```bash
# ローカル起動（http://127.0.0.1:3010 で待ち受け）
pnpm sample:hono-cloudflare
pnpm sample:express-flyio
pnpm sample:fastify-flyio
pnpm sample:nextjs-vercel

# デプロイ（ガイド付き。ログイン等どうしても人間が必要な操作のみ対話で案内）
pnpm deploy:hono-cloudflare
pnpm deploy:express-flyio
pnpm deploy:fastify-flyio
pnpm deploy:nextjs-vercel
```

デプロイスクリプトは冪等で、アプリ名・issuer などの決定事項は各サンプルの `.deploy/`（gitignore済み）に保存されるため、2回目以降は確認なしで再デプロイされる。各スクリプトは `--dry-run` で実行内容だけを確認でき、`--help` でガイド内容の全体像を表示する。

デプロイされるOPはあくまで検証用であり、署名鍵は起動時生成（固定・ローテーション非対応）である点に注意。
