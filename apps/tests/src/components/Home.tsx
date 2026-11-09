/**
 * The home page: in the build of a pull request a line to its tests and the
 * legend of its marks; how many tests there are and of what kind, how the
 * latest run went and how many expect success or failure; the three kinds of
 * tests (E2E, API, unit), each a way into its tests by what they test (with,
 * in the build of a pull request, how many of them it touched); then the
 * endpoints of the chosen source as cards, each with its own tests at a
 * glance (its API and E2E tests and the unit tests of its steps) and, in the
 * build of a pull request, how many of them it added, changed and removed.
 */
import type { TestCounts } from '@maronn-openid-connect/test-catalog/model';
import { countsOf, endpointGroups, endpointRemoved, endpointTests, healthOf, KIND_LABELS, KIND_NAMES, KIND_NOTES, kindChanges, KINDS, type Db } from '../lib/data';
import { formatCount, formatDate } from '../lib/format';
import { prCounts } from '../lib/pr';
import { formatHash, MAIN_KINDS, type MainKind, type Source } from '../lib/route';
import { useApp, useTitle } from './app-context';
import { PrCountsText, PrLegend } from './PrMarks';
import { HealthMark, Legend, PartsBar, SourceSwitch, type BarPart } from './ui';

/** The kinds of some counts as the parts of a bar; `tool` only when asked, since the endpoints have none. */
export function kindParts(counts: TestCounts | undefined, withTools = false): BarPart[] {
  return KINDS.filter((kind) => withTools || kind !== 'tool').map((kind) => ({ key: kind, label: KIND_LABELS[kind], value: counts?.kinds?.[kind] ?? 0 }));
}

/** In the build of a pull request: how many tests it had and has and how many it touched, a link to them, and what the marks mean. */
function PrLine({ db }: { db: Db }) {
  const marks = db.pr;
  const counts = marks?.diff.counts;
  const changes = marks === undefined ? undefined : prCounts(marks, marks.byId.keys(), marks.removed);
  return (
    <div className="pr-head">
      <a className="pr-line" href={formatHash({ page: 'pr' })}>
        <span className="pr-line-label">この PR</span>
        {counts === undefined ? (
          <span>のテスト</span>
        ) : (
          <span className="num">
            テスト {formatCount(counts.before ?? 0)} → {formatCount(counts.after ?? 0)}
          </span>
        )}
        {changes !== undefined && <PrCountsText counts={changes} className="pr-line-counts" full words />}
        <span aria-hidden="true">→</span>
      </a>
      {marks !== undefined && <PrLegend />}
    </div>
  );
}

function Tiles({ db }: { db: Db }) {
  const counts = db.index.counts;
  const results = counts?.results ?? {};
  const failed = results.failed ?? 0;
  const kinds = kindParts(counts, true);
  const outcomes: BarPart[] = [
    { key: 'success', label: '正常系', value: counts?.outcomes?.success ?? 0 },
    { key: 'failure', label: '異常系', value: counts?.outcomes?.failure ?? 0 },
    { key: 'unknown', label: '判定なし', value: counts?.outcomes?.unknown ?? 0 },
  ];
  const ran = (results.passed ?? 0) + failed + (results.skipped ?? 0);
  const date = formatDate(db.index.run?.at);
  return (
    <section className="tiles" aria-label="概要">
      <div className="tile">
        <h2 className="tile-label">テスト数</h2>
        <p className="tile-value">{formatCount(counts?.total ?? db.index.tests.length)}</p>
        <PartsBar parts={kinds} />
        <Legend parts={kinds} counts />
      </div>
      <div className="tile">
        <h2 className="tile-label">最新の実行</h2>
        {ran === 0 ? (
          <p className="tile-value tile-quiet">結果なし</p>
        ) : failed > 0 ? (
          <p className="tile-value tile-failed">
            <span aria-hidden="true">✗ </span>
            {formatCount(failed)} 件失敗
          </p>
        ) : (
          <p className="tile-value tile-passed">
            <span aria-hidden="true">✓ </span>
            すべて成功
          </p>
        )}
        <ul className="tile-facts">
          <li>
            成功 <span className="num">{formatCount(results.passed ?? 0)}</span>
          </li>
          {failed > 0 && (
            <li>
              失敗 <span className="num">{formatCount(failed)}</span>
            </li>
          )}
          {(results.skipped ?? 0) > 0 && (
            <li>
              スキップ <span className="num">{formatCount(results.skipped ?? 0)}</span>
            </li>
          )}
          <li>
            結果なし <span className="num">{formatCount(results.none ?? 0)}</span>
          </li>
        </ul>
        {date !== '' && <p className="tile-note">{date} の実行</p>}
      </div>
      <div className="tile">
        <h2 className="tile-label">正常系 : 異常系</h2>
        <p className="tile-value">
          {formatCount(outcomes[0]?.value ?? 0)} <span className="tile-colon">:</span> {formatCount(outcomes[1]?.value ?? 0)}
        </p>
        <PartsBar parts={outcomes} />
        <Legend parts={outcomes} counts />
      </div>
    </section>
  );
}

/** How each kind's page groups its tests. */
const KIND_GROUPING: Record<MainKind, string> = { e2e: 'spec・シナリオのファイルごと', api: 'エンドポイントごと', unit: '関数ごと' };

/** The three kinds of tests as cards: what each checks, how many there are, and a way into them. */
function Kinds({ db }: { db: Db }) {
  return (
    <section className="kinds" aria-labelledby="kinds-title">
      <h2 id="kinds-title" className="section-title">
        テストの種類
      </h2>
      <ul className="kind-cards">
        {MAIN_KINDS.map((kind) => {
          const changes = kindChanges(db, kind);
          return (
            <li key={kind}>
              <a className={`kind-card kind-card-${kind}`} href={formatHash({ page: 'kind', testKind: kind })}>
                <span className="kind-card-top">
                  <span className={`swatch part-${kind}`} aria-hidden="true" />
                  <span className="kind-card-name">{KIND_NAMES[kind]}</span>
                  <span className="kind-card-count num">{formatCount(db.index.counts?.kinds?.[kind] ?? 0)}</span>
                  {changes !== undefined && <PrCountsText counts={changes} className="kind-card-pr" label="PR" />}
                </span>
                <span className="kind-card-note">{KIND_NOTES[kind]}</span>
                <span className="kind-card-go">
                  {KIND_GROUPING[kind]}に見る <span aria-hidden="true">→</span>
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Endpoints({ db, source }: { db: Db; source: Source }) {
  const groups = endpointGroups(db, source);
  if (groups.length === 0) return <p className="note">エンドポイントの一覧（outline.json）がありません。</p>;
  return (
    <section className="endpoints" aria-labelledby="endpoints-title">
      <div className="section-head">
        <h2 id="endpoints-title">エンドポイント</h2>
        <Legend parts={kindParts(undefined)} />
      </div>
      <SourceSwitch place="body" />
      <div className="groups">
        {groups.map((group) => (
          <section key={group.id} className="group" aria-labelledby={`group-${group.id}`}>
            <h3 id={`group-${group.id}`} className="group-label">
              {group.label}
            </h3>
            <ul className="cards">
              {group.endpoints.map((endpoint) => {
                const tests = endpointTests(db, endpoint);
                const counts = countsOf(tests);
                const changes = db.pr === undefined ? undefined : prCounts(db.pr, tests.map((test) => test.id), endpointRemoved(db, endpoint));
                return (
                  <li key={endpoint.key}>
                    <a className="card" href={formatHash({ page: 'endpoint', source: endpoint.source, endpoint: endpoint.id })}>
                      <span className="card-top">
                        <HealthMark health={healthOf(counts.results)} />
                        <span className="card-label">{endpoint.label}</span>
                        <span className="card-count num" aria-label={`テスト ${formatCount(counts.total)} 件`}>
                          {formatCount(counts.total)}
                        </span>
                      </span>
                      <span className="card-path-line">
                        <span className="card-path">
                          <span className="method">{endpoint.methods.join(' · ')}</span> {endpoint.path}
                        </span>
                        {changes !== undefined && <PrCountsText counts={changes} className="card-pr" label="PR" />}
                      </span>
                      <PartsBar parts={kindParts(counts)} />
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </section>
  );
}

export function Home() {
  const { db, source } = useApp();
  useTitle(undefined);
  return (
    <div className="page home">
      {db.index.diff === true && <PrLine db={db} />}
      <Tiles db={db} />
      <Kinds db={db} />
      <Endpoints db={db} source={source} />
      <nav className="quiet-links" aria-label="ほかの見方">
        <a href={formatHash({ page: 'files' })}>ファイルから探す →</a>
        {db.index.diff === true && <a href={formatHash({ page: 'pr' })}>この PR のテスト →</a>}
      </nav>
    </div>
  );
}
