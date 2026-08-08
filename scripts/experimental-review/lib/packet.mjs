/**
 * 昇格レビューパケットの Markdown を組み立てる純粋関数群。
 *
 * 入力（model）はすべて呼び出し側で収集済みのデータで、この module は
 * ファイルシステムにも git にも触れない。出力は {path, content} の配列
 * （パスはパケットディレクトリからの相対）で、decision.md は含めない。
 * decision.md は人間専用ファイルであり、生成・保護は CLI 側が担う。
 */

/** 差分テキストが同一のフレームワークを 1 つのグループへまとめる。 */
export function groupFrameworksByDiff(frameworkDiffs) {
  const groups = [];
  const byPatch = new Map();
  for (const entry of frameworkDiffs) {
    const existing = byPatch.get(entry.patch);
    if (existing) {
      existing.frameworks.push(entry.framework);
      continue;
    }
    const group = {
      frameworks: [entry.framework],
      patch: entry.patch,
      classification: entry.classification,
      stats: entry.stats,
    };
    byPatch.set(entry.patch, group);
    groups.push(group);
  }
  for (const group of groups) {
    group.docFile = `generated-code/${group.frameworks.join('-')}.md`;
  }
  return groups;
}

function repoLink(relPrefix, repoPath) {
  return `[${repoPath}](${relPrefix}/${repoPath})`;
}

function fileTable(relPrefix, files) {
  const rows = files.map((f) => `| ${repoLink(relPrefix, f.path)} | ${f.lines} |`);
  return ['| ファイル | 行数 |', '|---|---|', ...rows].join('\n');
}

function mentionTable(relPrefix, entries) {
  const rows = entries.map((e) => `| ${repoLink(relPrefix, e.path)} | ${e.mentions} |`);
  return ['| ファイル | 言及回数 |', '|---|---|', ...rows].join('\n');
}

function frameworksLabel(group) {
  return group.frameworks.join(' / ');
}

/** パケットの入口となる README.md を描画する。 */
export function renderPacketReadme(model) {
  const {
    featureId,
    specName,
    relPrefix,
    experimentalSrc,
    cliReferences,
    generated,
    samples,
    e2e,
    docs,
    taskDocs,
  } = model;

  const lines = [];
  lines.push(`# 昇格レビューパケット: ${featureId}`);
  lines.push('');
  lines.push(`> **このディレクトリは \`pnpm review:experimental ${featureId}\` が生成した機械生成物です。**`);
  lines.push('> `decision.md` 以外はツールが再生成のたびに作り直します。手で編集しないでください。');
  lines.push('');
  lines.push(`experimental 機能 \`${featureId}\` を experimental から外してよいか（昇格させてよいか）を、`);
  lines.push('**人間がレビューして判断する** ための材料一式です。');
  lines.push('ツールは材料の収集と差分の切り出しだけを行い、判断はしません。');
  lines.push('判断は [decision.md](./decision.md) に記録してください。');
  lines.push('');
  if (specName) {
    lines.push(`- 準拠仕様: ${specName}`);
  }
  for (const doc of taskDocs) {
    lines.push(`- ${repoLink(relPrefix, doc.path)}`);
  }
  lines.push('');

  lines.push('## 1. この機能を構成するコードの地図');
  lines.push('');
  lines.push('### 1.1 experimental パッケージ本体（ロジック層）');
  lines.push('');
  lines.push(`実装（${repoLink(relPrefix, experimentalSrc.dir)}）:`);
  lines.push('');
  lines.push(fileTable(relPrefix, experimentalSrc.implFiles));
  lines.push('');
  lines.push('単体テスト:');
  lines.push('');
  lines.push(fileTable(relPrefix, experimentalSrc.testFiles));
  lines.push('');

  lines.push('### 1.2 CLI 統合（コード生成側）');
  lines.push('');
  lines.push(`\`packages/cli\` 内で \`${featureId}\` に言及しているファイル（言及回数は機械カウント）:`);
  lines.push('');
  lines.push(mentionTable(relPrefix, cliReferences));
  lines.push('');
  lines.push('テンプレートファイルは巨大なため、直接読むより **次節の生成コード差分で読む** ことを推奨します。');
  lines.push('テンプレート側の変更意図を確認したいときだけ、上の言及箇所を検索してください。');
  lines.push('');

  lines.push('### 1.3 生成コードへの寄与（このパケットの中心）');
  lines.push('');
  lines.push(`\`maronn-oidc generate <framework>\`（デフォルト構成 = \`${generated.baselineLabel}\`）に`);
  lines.push(`\`--enable ${featureId}\`（= \`${generated.enabledLabel}\`）を足したときに生成コードへ入る差分だけを、`);
  lines.push('フレームワークごとに機械的に切り出したものです。**他機能のコードは一切混ざっていません。**');
  lines.push('');
  lines.push('| フレームワーク | 差分ドキュメント | 追加 | 変更 | 削除 | 規模 |');
  lines.push('|---|---|---|---|---|---|');
  for (const group of generated.groups) {
    const c = group.classification;
    lines.push(
      `| ${frameworksLabel(group)} | [${group.docFile}](./${group.docFile}) | ${c.added.length} | ${c.changed.length} | ${c.removed.length} | +${group.stats.insertions} / -${group.stats.deletions} |`,
    );
  }
  lines.push('');
  lines.push('差分に **現れない** 生成ファイル（この機能のレビューでは読む必要がないもの）:');
  lines.push('');
  for (const group of generated.groups) {
    lines.push(`- ${frameworksLabel(group)}: ${group.classification.unchanged.join(', ')}`);
  }
  lines.push('');
  lines.push('`conformance.test.ts` の差分には、この機能が生成 OP に保証させる挙動（契約テスト）が');
  lines.push('すべて含まれます。**仕様と実装の突き合わせはここを起点にしてください。**');
  lines.push('');

  lines.push('### 1.4 サンプルでの実配置');
  lines.push('');
  lines.push('| サンプル | --enable | この機能 |');
  lines.push('|---|---|---|');
  for (const sample of samples) {
    const enabledList = sample.enabledFeatures.length > 0 ? sample.enabledFeatures.join(', ') : '（なし）';
    const usage = sample.usesFeature ? '**有効**' : '無効';
    lines.push(`| ${repoLink(relPrefix, `samples/${sample.name}`)} | ${enabledList} | ${usage} |`);
  }
  lines.push('');
  lines.push('有効なサンプルの生成ディレクトリ（`src/oidc-provider` など）は、他機能と併用した合成結果です。');
  lines.push('単独の寄与は 1.3 の差分で、他機能との併用結果はサンプルの実コードと conformance.test.ts で確認できます。');
  lines.push('');

  lines.push('### 1.5 E2E テスト（実ブラウザ・実 HTTP フロー）');
  lines.push('');
  if (e2e.length > 0) {
    lines.push(mentionTable(relPrefix, e2e));
  } else {
    lines.push('（この機能に言及する E2E ファイルは見つかりませんでした。E2E 不足自体をレビュー観点にしてください）');
  }
  lines.push('');

  lines.push('### 1.6 ドキュメント');
  lines.push('');
  if (docs.length > 0) {
    lines.push(mentionTable(relPrefix, docs));
  } else {
    lines.push('（この機能に言及するドキュメントは見つかりませんでした）');
  }
  lines.push('');

  lines.push('## 2. 推奨レビュー手順');
  lines.push('');
  lines.push('1. 仕様書（specification.md）と review-log.md を読み、期待挙動と過去の論点を把握する');
  lines.push('2. 1.1 の experimental 本体実装と単体テストを読む');
  lines.push('3. 1.3 の生成コード差分を読む（conformance.test.ts の差分 = この機能の契約）');
  lines.push('4. 必要に応じて 1.4 のサンプルで他機能との併用結果を確認し、実起動して触る（`pnpm sample:hono-cloudflare` など）');
  lines.push('5. 1.5 の E2E テストを読む・実行する（`pnpm test:e2e`）');
  lines.push('6. [decision.md](./decision.md) のチェックリストを埋め、判断を記録する');
  lines.push('');

  lines.push('## 3. 鮮度について');
  lines.push('');
  lines.push('このパケットは生成時点のリポジトリ内容のスナップショットです。');
  lines.push(`\`pnpm review:experimental ${featureId} --check\` が失敗する場合、パケット生成後に実装が変わっています。`);
  lines.push('再生成して差分を確認してから判断してください。判断の記録時には `reviewed_commit` に');
  lines.push('`--check` が通った時点のコミット SHA を残すと、あとから「何を見て判断したか」を追えます。');
  lines.push('');

  return lines.join('\n');
}

/** 生成コード差分グループ 1 つぶんのドキュメントを描画する。 */
export function renderGeneratedCodeDoc(model, group) {
  const { featureId, generated } = model;
  const label = frameworksLabel(group);
  const c = group.classification;

  const lines = [];
  lines.push(`# 生成コード差分: ${featureId} — ${label}`);
  lines.push('');
  lines.push('> 機械生成物です。手で編集しないでください。[パケットの説明に戻る](../README.md)');
  lines.push('');
  lines.push('比較しているもの:');
  lines.push('');
  lines.push(`- \`a/${generated.baselineLabel}/...\`: \`maronn-oidc generate <framework>\`（experimental 機能なしのデフォルト構成）`);
  lines.push(`- \`b/${generated.enabledLabel}/...\`: \`maronn-oidc generate <framework> --enable ${featureId}\``);
  lines.push('');
  lines.push(`この差分が「\`--enable ${featureId}\` が生成コードに足すものすべて」です。`);
  if (group.frameworks.length > 1) {
    lines.push('');
    lines.push(`${label} の生成コード差分は完全に同一のため、まとめて表示しています。`);
  }
  lines.push('');
  lines.push('## サマリ');
  lines.push('');
  lines.push('| 種別 | ファイル |');
  lines.push('|---|---|');
  lines.push(`| 追加 | ${c.added.join(', ') || '（なし）'} |`);
  lines.push(`| 変更 | ${c.changed.join(', ') || '（なし）'} |`);
  lines.push(`| 削除 | ${c.removed.join(', ') || '（なし）'} |`);
  lines.push('');
  lines.push('## 差分');
  lines.push('');
  lines.push('````diff');
  lines.push(group.patch);
  lines.push('````');
  lines.push('');

  return lines.join('\n');
}

/** パケットのツール生成ファイル一式（decision.md を除く）を組み立てる。 */
export function buildPacketFiles(model) {
  const files = [{ path: 'README.md', content: renderPacketReadme(model) }];
  for (const group of model.generated.groups) {
    files.push({ path: group.docFile, content: renderGeneratedCodeDoc(model, group) });
  }
  return files;
}
