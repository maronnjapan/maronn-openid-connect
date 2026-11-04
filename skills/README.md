# リポジトリの skills

[provider-map-traceability](provider-map-traceability/SKILL.md) は、OIDC Provider の配線をエンドポイントから型で辿り、地図と PR の差分に残すための作業手順である。振る舞い・コンテキスト・フック・コールバック・初期化を追加・変更するときや、地図から漏れる処理を調べるときに使う。

エージェントへの依頼に `skills/provider-map-traceability/SKILL.md を読んで適用して` と書けば使える。規則の正本は設計文書と lint・地図の検査であり、skill はそれらを確認して作業するための手順である。

自動発見を使う場合は、このディレクトリを各ツールの skill 配置先へローカルにコピーするかリンクする。例えば、リポジトリルートで次を実行すると Codex 用の配置になる。

```sh
mkdir -p .agents/skills
ln -s ../../skills/provider-map-traceability .agents/skills/provider-map-traceability
```

Claude Code で使う場合は配置先を `.claude/skills` にする。既存の同名 skill を上書きせず、対象ツールの現在の skill 読込み仕様を確認する。`.agents/` と `.claude/` はこのリポジトリでは個人の作業設定として無視されるため、配布する正本は `skills/` にだけ置く。

解析モデル・生成・検査のコマンドを変更した PR では、この skill の参照先と手順も更新する。到達先や件数を skill に固定せず、毎回生成した出力から確かめる。
