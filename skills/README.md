# リポジトリの skills

| 用途 | skill | 手順の正本 |
| --- | --- | --- |
| 実装・修正 | `provider-map-implementation` | [実装手順](provider-map-implementation/SKILL.md) |
| 実装・PR のレビュー | `provider-map-review` | [レビュー手順](provider-map-review/SKILL.md) |

地図の根・型の経路・出力の読み方と検証コマンドは [共通資料](references/provider-map-evidence.md) にまとめた。規則の正本は設計文書と lint・地図の検査であり、skills はそれらを確かめて作業するための手順である。

## Codex / Claude Code から使う

次の標準配置へ、自動発見用の `SKILL.md` を実ファイルとしてコミットしている。clone 後にコピーやリンク作成は要らない。Codex のディレクトリ名は `.agents`（複数形）である。

| クライアント | 実装用の入口 | レビュー用の入口 |
| --- | --- | --- |
| Codex | [.agents/skills/provider-map-implementation](../.agents/skills/provider-map-implementation/SKILL.md) | [.agents/skills/provider-map-review](../.agents/skills/provider-map-review/SKILL.md) |
| Claude Code | [.claude/skills/provider-map-implementation](../.claude/skills/provider-map-implementation/SKILL.md) | [.claude/skills/provider-map-review](../.claude/skills/provider-map-review/SKILL.md) |

リポジトリ内でクライアントを起動する。Codex では `$provider-map-implementation` / `$provider-map-review`、Claude Code では `/provider-map-implementation` / `/provider-map-review` で選べる。実行中のセッションで一覧が更新されなければ、そのクライアントのセッションを開き直す。

自動発見を使わない場合は「`skills/provider-map-implementation/SKILL.md` を読んで実装して」「`skills/provider-map-review/SKILL.md` を読んでレビューして」と依頼できる。レビュー用は、検証に必要な一時出力は作成できるが、既定ではコード修正・commit・GitHub 投稿を行わず、根拠のある指摘を返す。

## 更新する

実装・レビューの手順は `skills/`、共通の事実と読み方は `skills/references/` を更新する。各クライアントの入口は必ず正本を読むため、手順を複製・同期しない。名前・用途・正本の場所を変える場合だけ、両クライアントの入口とこの表も更新する。

`.gitignore` はこの 2 skill のディレクトリだけを共有対象にし、各ツールの個人設定やほかの skills は引き続き無視する。旧 `provider-map-traceability` は実装用・レビュー用へ分割済みで、単独の入口としては残さない。
