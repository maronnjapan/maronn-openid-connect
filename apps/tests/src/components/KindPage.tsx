/**
 * The tests of one kind, by what they test, each row saying it:
 *
 * - E2E by their file, each with the route of endpoints it goes through;
 * - API by the endpoint they request, on the chosen source, then the API
 *   tests whose requests go to routes of their own or of the app
 *   (「テストやアプリのルートへのリクエスト」), by the function or the code
 *   they name, and last those whose requests go to paths known only at run
 *   time (「パスが実行時に決まるリクエスト」);
 * - unit by package, then module and function, folded: a module opens on
 *   its functions with their counts, a function on its tests, and a
 *   function's code opens in the panel.
 *
 * The three kinds are links at the top, so the reader moves between them.
 * In the build of a pull request a group says how many of its tests the
 * pull request touched, has the tests it removed from there among the
 * others, and a switch keeps only the changed tests (opening every module).
 */
import type { TestEntry } from '@maronn-openid-connect/test-catalog/model';
import { Fragment, useMemo, useState } from 'react';
import { KIND_LABELS, KIND_NAMES, KIND_NOTES, kindChanges, splitPath, type Db } from '../lib/data';
import { formatCount } from '../lib/format';
import { apiEndpoints, e2eFiles, testsOfKind, unitPackages, type OutsideGroup, type UnitFunction, type UnitModule } from '../lib/kinds';
import { prCounts, type PrMarks, type RemovedTest } from '../lib/pr';
import { formatHash, MAIN_KINDS, type MainKind, type OutcomeFilter } from '../lib/route';
import { useApp, useTitle } from './app-context';
import { CodeButton, SOURCE_NAMES } from './CodeRefs';
import { ChangedToggle, PrCountsText, PrDot } from './PrMarks';
import { OutcomeFilterControl, rowOf, Rows, useChangedOnly } from './TestList';
import { Chips, SourceSwitch, Words } from './ui';

/** A package with more modules than this opens with its modules folded. */
const OPEN_MODULES = 8;

/** The three kinds as links, the current one marked; in the build of a pull request with a dot of how many of each it touched. */
function KindLinks({ db, current }: { db: Db; current: MainKind }) {
  return (
    <nav className="kind-links" aria-label="テストの種類">
      {MAIN_KINDS.map((kind) => {
        const changes = kindChanges(db, kind);
        return (
          <a key={kind} href={formatHash({ page: 'kind', testKind: kind })} aria-current={kind === current ? 'page' : undefined}>
            <span className={`swatch part-${kind}`} aria-hidden="true" />
            {KIND_LABELS[kind]}
            <span className="kind-link-count num">{formatCount(db.index.counts.kinds?.[kind] ?? 0)}</span>
            {/* A dot, so the three links stay on one line of a phone; its title says what changed. */}
            {changes !== undefined && <PrDot counts={changes} what="テスト" />}
          </a>
        );
      })}
    </nav>
  );
}

/** What the lists of a kind page keep: the outcome chosen and, with the switch on, the tests the pull request changed. */
interface Keep {
  outcome: OutcomeFilter;
  /** Whether the switch 「この PR の変更だけ」 is on. */
  on: boolean;
  /** A key that changes with the filters, so a list starts at its first rows again. */
  key: string;
  test: (entry: TestEntry) => boolean;
  removed: (test: RemovedTest) => boolean;
  /** Whether the pull request touched a test (whatever the switch). */
  changed: (entry: Pick<TestEntry, 'id'>) => boolean;
}

function useKeep(): Keep {
  const outcome: OutcomeFilter = useApp().view.outcome ?? 'both';
  const changedOnly = useChangedOnly();
  const ofOutcome = (value: string | undefined) => outcome === 'both' || value === outcome;
  return {
    outcome,
    on: changedOnly.on,
    key: `${outcome}:${changedOnly.on}`,
    test: (entry) => ofOutcome(entry.outcome) && changedOnly.keep(entry),
    removed: (test) => ofOutcome(test.outcome),
    changed: changedOnly.changed,
  };
}

/** How many of some tests the pull request changed, with its removed ones, for the switch: those the outcome keeps, each once. */
function changesOf(keep: Keep, groups: ReadonlyArray<{ tests: readonly TestEntry[]; removed: readonly RemovedTest[] }>): number {
  const ids = new Set<string>();
  for (const group of groups) {
    for (const entry of group.tests) if (keep.changed(entry) && (keep.outcome === 'both' || entry.outcome === keep.outcome)) ids.add(entry.id);
    for (const test of group.removed) if (keep.removed(test)) ids.add(test.id);
  }
  return ids.size;
}

/** `+2 ~1 −0` of a group's tests, in the build of a pull request. */
function GroupChanges({ marks, tests, removed }: { marks: PrMarks | undefined; tests: readonly TestEntry[]; removed: readonly RemovedTest[] }) {
  if (marks === undefined) return null;
  return <PrCountsText counts={prCounts(marks, new Set(tests.map((test) => test.id)), [...new Set(removed)])} className="group-pr" />;
}

/** The note of an empty list: nothing of the filters, or nothing the pull request changed. */
function emptyNote(keep: Keep): string {
  return keep.on ? 'この PR で変わったテストはありません' : '該当するテストはありません';
}

function E2eTests({ db }: { db: Db }) {
  const keep = useKeep();
  const files = useMemo(() => e2eFiles(db), [db]);
  const groups = files.map((file) => ({ ...file, tests: file.tests.filter(keep.test), removed: file.removed.filter(keep.removed) })).filter((file) => file.tests.length + file.removed.length > 0);
  return (
    <>
      <div className="filters">
        <OutcomeFilterControl />
        <ChangedToggle count={changesOf(keep, files)} />
      </div>
      {groups.length === 0 && <p className="note">{emptyNote(keep)}</p>}
      <div className="kind-groups">
        {groups.map((file) => (
          <section key={file.file} className="kind-group" aria-label={file.title}>
            <div className="kind-group-head">
              <h2 className="kind-group-title">{file.title}</h2>
              <span className="kind-group-count num">{formatCount(file.tests.length)}</span>
              <GroupChanges marks={db.pr} tests={file.tests} removed={file.removed} />
              <a className="kind-group-file" href={formatHash({ page: 'file', file: file.file })} title={file.file}>
                {splitPath(file.file).name}
              </a>
            </div>
            <Rows key={keep.key} rows={file.tests.map(rowOf)} removed={file.removed} hideFile target={{}} />
          </section>
        ))}
      </div>
    </>
  );
}

/** A group of the API tests of routes that are no endpoint of the OP: the function they name (its code in the panel), or their describe and file. */
function OutsideGroupItem({ db, group, keep }: { db: Db; group: OutsideGroup; keep: Keep }) {
  const code = group.fn === undefined ? undefined : db.functions[group.fn]?.code;
  return (
    <section className="outside-group" aria-label={group.name}>
      <div className="kind-group-head outside-group-head">
        <h3 className="outside-group-name">
          <span className="mono">{group.name}</span>
          {group.qualifier !== undefined && <span className="target-qualifier">（{group.qualifier}）</span>}
        </h3>
        <span className="kind-group-count num">{formatCount(group.tests.length)}</span>
        <GroupChanges marks={db.pr} tests={group.tests} removed={group.removed} />
        {code !== undefined && group.fn !== undefined && <CodeButton target={{ kind: 'fn', id: group.fn }} label={`${group.name} のコードを見る`} text="コード" />}
        {group.file !== undefined && (
          <a className="kind-group-file" href={formatHash({ page: 'file', file: group.file })} title={group.file}>
            {splitPath(group.file).name}
          </a>
        )}
      </div>
      {/* The heading names the function or the code the tests are of: a row leaves it out and says its routes. */}
      <Rows key={keep.key} rows={group.tests.map(rowOf)} removed={group.removed} target={{ ...(group.fn === undefined ? {} : { known: [group.fn] }), named: group.name }} />
    </section>
  );
}

/** The API tests of no endpoint of a kind of route, by the function or the code their describe names: those of routes of their own or of the app, or those of paths known only at run time. */
function OutsideSection({ db, id, title, note, groups, keep }: { db: Db; id: string; title: string; note: string; groups: readonly OutsideGroup[]; keep: Keep }) {
  if (groups.length === 0) return null;
  const count = new Set(groups.flatMap((group) => group.tests.map((test) => test.id))).size;
  return (
    <section className="kind-group outside" aria-labelledby={id}>
      <div className="kind-group-head">
        <h2 id={id} className="kind-group-title">
          {title}
        </h2>
        <span className="kind-group-count num">{formatCount(count)}</span>
      </div>
      <p className="outside-note">{note}</p>
      <div className="outside-groups">
        {groups.map((group) => (
          <OutsideGroupItem key={group.key} db={db} group={group} keep={keep} />
        ))}
      </div>
    </section>
  );
}

function ApiTests({ db }: { db: Db }) {
  const { source } = useApp();
  const keep = useKeep();
  const groups = useMemo(() => apiEndpoints(db, source), [db, source]);
  const shown = groups.endpoints.map((group) => ({ ...group, tests: group.tests.filter(keep.test), removed: group.removed.filter(keep.removed) })).filter((group) => group.tests.length + group.removed.length > 0);
  const kept = (list: readonly OutsideGroup[]) => list.map((group) => ({ ...group, tests: group.tests.filter(keep.test), removed: group.removed.filter(keep.removed) })).filter((group) => group.tests.length + group.removed.length > 0);
  const outside = kept(groups.outside);
  const runtime = kept(groups.runtime);
  return (
    <>
      {/* On a phone the source (in the header on a desk) and the outcome share a row. */}
      <div className="filters filters-api">
        <SourceSwitch place="body" />
        <OutcomeFilterControl />
        <ChangedToggle count={changesOf(keep, [...groups.endpoints, ...groups.outside, ...groups.runtime])} />
      </div>
      {shown.length === 0 && outside.length === 0 && runtime.length === 0 && <p className="note">{keep.on ? emptyNote(keep) : `${SOURCE_NAMES[source]} の該当するテストはありません`}</p>}
      <div className="kind-groups">
        {shown.map(({ endpoint, tests, removed }) => (
          <section key={endpoint.key} className="kind-group" aria-label={endpoint.label}>
            <div className="kind-group-head">
              <h2 className="kind-group-title">
                <a href={formatHash({ page: 'endpoint', source: endpoint.source, endpoint: endpoint.id })}>{endpoint.label}</a>
              </h2>
              <span className="kind-group-count num">{formatCount(tests.length)}</span>
              <GroupChanges marks={db.pr} tests={tests} removed={removed} />
              <span className="kind-group-path">
                <span className="method">{endpoint.methods.join(' · ')}</span> {endpoint.path}
              </span>
              {endpoint.code !== undefined && <CodeButton target={{ kind: 'endpoint', key: endpoint.key }} label={`${endpoint.label}（${SOURCE_NAMES[endpoint.source]}）のコードを見る`} text="コード" />}
            </div>
            <Rows key={keep.key} rows={tests.map(rowOf)} removed={removed} target={{ current: endpoint.id }} />
          </section>
        ))}
        <OutsideSection
          db={db}
          id="outside-title"
          title="テストやアプリのルートへのリクエスト"
          note="テストが自分で登録したルートや、アプリの /health・運用者の API など、OP のエンドポイントではないルートにリクエストを送る API テストです。テストが describe に書いた関数やクラスごとに並べます。"
          groups={outside}
          keep={keep}
        />
        <OutsideSection
          db={db}
          id="runtime-title"
          title="パスが実行時に決まるリクエスト"
          note="URL がコードに書かれておらず、テストを動かすまでどこへ送るか分からないリクエストの API テストです。テストが describe に書いた関数ごとに並べます。"
          groups={runtime}
          keep={keep}
        />
      </div>
      {groups.untested.length > 0 && (
        <p className="untested-line">
          <span className="untested-label">API テストのないエンドポイント（{SOURCE_NAMES[source]}）</span>
          {groups.untested.map((endpoint, index) => (
            <span key={endpoint.key}>
              {index > 0 && '、'}
              <a href={formatHash({ page: 'endpoint', source: endpoint.source, endpoint: endpoint.id })}>{endpoint.label}</a>
            </span>
          ))}
        </p>
      )}
    </>
  );
}

/** A function of a module: its name, its count and its code; its tests when opened. */
function UnitFunctionItem({ db, fn, tests, removed, alone, keep }: { db: Db; fn: UnitFunction; tests: TestEntry[]; removed: RemovedTest[]; alone: boolean; keep: Keep }) {
  const [open, setOpen] = useState(alone || keep.on);
  const code = db.functions[fn.id]?.code;
  return (
    <li className={open ? 'unit-fn unit-fn-open' : 'unit-fn'}>
      <div className="unit-fn-head">
        <button type="button" className="unit-fn-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="chevron" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span className="unit-fn-name mono">{fn.name}</span>
          <span className="kind-group-count num">{formatCount(tests.length)}</span>
          <GroupChanges marks={db.pr} tests={tests} removed={removed} />
        </button>
        {code !== undefined && <CodeButton target={{ kind: 'fn', id: fn.id }} label={`${fn.name} のコードを見る`} text="コード" />}
      </div>
      {fn.summary !== undefined && fn.summary !== '' && (
        <p className="unit-fn-summary">
          <Words text={fn.summary} />
        </p>
      )}
      {open && (
        <div className="unit-fn-tests">
          <Rows rows={tests.map(rowOf)} removed={removed} target={{ known: [fn.id] }} />
        </div>
      )}
    </li>
  );
}

/** A path that breaks after its slashes on a narrow screen, not inside a name. */
function PathText({ path }: { path: string }) {
  const parts = path.split('/');
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {part}
          {index < parts.length - 1 && (
            <>
              /<wbr />
            </>
          )}
        </Fragment>
      ))}
    </>
  );
}

/** A module of a package: folded to its path and count; open, its functions. */
function UnitModuleItem({ db, module, keep, startOpen }: { db: Db; module: UnitModule; keep: Keep; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const groups = module.functions.map((fn) => ({ fn, tests: fn.tests.filter(keep.test), removed: fn.removed.filter(keep.removed) })).filter((group) => group.tests.length + group.removed.length > 0);
  if (groups.length === 0) return null;
  const tests = [...new Map(groups.flatMap((group) => group.tests.map((test) => [test.id, test] as const))).values()];
  const removed = [...new Set(groups.flatMap((group) => group.removed))];
  return (
    <details className="unit-module" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="unit-module-head">
        <span className="chevron" aria-hidden="true" />
        <span className="unit-module-path mono">
          <PathText path={module.module} />
        </span>
        <span className="kind-group-count num">{formatCount(tests.length)}</span>
        <GroupChanges marks={db.pr} tests={tests} removed={removed} />
        {!open && <span className="unit-module-fns">関数 {formatCount(groups.length)}</span>}
      </summary>
      {open && (
        <ul className="unit-fns">
          {groups.map((group) => (
            <UnitFunctionItem key={group.fn.id} db={db} fn={group.fn} tests={group.tests} removed={group.removed} alone={groups.length === 1} keep={keep} />
          ))}
        </ul>
      )}
    </details>
  );
}

/** The unit tests of a package whose function the reader could not find, folded like a module, with those of no function a pull request removed. */
function UnknownItem({ db, tests, removed, startOpen }: { db: Db; tests: TestEntry[]; removed: RemovedTest[]; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  if (tests.length + removed.length === 0) return null;
  return (
    <details className="unit-module" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="unit-module-head">
        <span className="chevron" aria-hidden="true" />
        <span className="unit-module-path">関数の分からないテスト</span>
        <span className="kind-group-count num">{formatCount(tests.length)}</span>
        <GroupChanges marks={db.pr} tests={tests} removed={removed} />
      </summary>
      {open && (
        <div className="unit-fn-tests">
          <Rows rows={tests.map(rowOf)} removed={removed} target={{}} />
        </div>
      )}
    </details>
  );
}

function UnitTests({ db }: { db: Db }) {
  const { view, go } = useApp();
  const keep = useKeep();
  const packages = useMemo(() => unitPackages(db), [db]);
  const pkg = packages.find((candidate) => candidate.name === view.pkg) ?? packages[0];
  if (pkg === undefined) return <p className="note">ユニットテストはありません</p>;
  const unknown = pkg.unknown.filter(keep.test);
  const unknownRemoved = pkg.unknownRemoved.filter(keep.removed);
  const shown =
    pkg.modules.some((module) => module.functions.some((fn) => fn.tests.some(keep.test) || fn.removed.some(keep.removed))) || unknown.length + unknownRemoved.length > 0;
  /** The tests of a package, each once, and the removed ones: the switch's count and the dot of its chip. */
  const testsOf = (candidate: (typeof packages)[number]) => ({
    tests: [...candidate.unknown, ...candidate.modules.flatMap((module) => module.functions.flatMap((fn) => fn.tests))],
    removed: [...new Set([...candidate.unknownRemoved, ...candidate.modules.flatMap((module) => module.functions.flatMap((fn) => fn.removed))])],
  });
  return (
    <>
      <div className="filters filters-unit">
        <Chips
          label="パッケージ"
          options={packages.map((candidate) => {
            const of = testsOf(candidate);
            return {
              value: candidate.name,
              label: (
                <>
                  {candidate.name}
                  {db.pr !== undefined && <PrDot counts={prCounts(db.pr, new Set(of.tests.map((test) => test.id)), of.removed)} />}
                </>
              ),
              count: candidate.count,
            };
          })}
          value={pkg.name}
          onChange={(value) => go({ ...view, pkg: value === packages[0]?.name ? undefined : value }, { replace: true })}
        />
        <OutcomeFilterControl />
        <ChangedToggle count={changesOf(keep, [testsOf(pkg)])} />
      </div>
      <p className="unit-note">モジュールを開くと関数が、関数を開くとそのテストが出ます。関数のテストは、その関数を describe に書いたテストと、期待値で結果を確かめているテストです。</p>
      {shown ? (
        <div key={`${pkg.name}:${keep.key}`} className="unit-modules">
          {pkg.modules.map((module) => (
            <UnitModuleItem key={module.module} db={db} module={module} keep={keep} startOpen={keep.on || pkg.modules.length <= OPEN_MODULES} />
          ))}
          <UnknownItem db={db} tests={unknown} removed={unknownRemoved} startOpen={keep.on} />
        </div>
      ) : (
        <p className="note">{emptyNote(keep)}</p>
      )}
    </>
  );
}

export function KindPage() {
  const { db, view } = useApp();
  const kind: MainKind = view.testKind ?? 'e2e';
  useTitle(KIND_NAMES[kind]);
  const count = useMemo(() => testsOfKind(db, kind).length, [db, kind]);
  return (
    <div className="page kind-page">
      <nav className="crumbs" aria-label="パンくず">
        <a href="#/">ホーム</a>
      </nav>
      <header className="page-head kind-page-head">
        <h1>{KIND_NAMES[kind]}</h1>
        <p className="lede">
          <span className="num">{formatCount(count)}</span> 件 · {KIND_NOTES[kind]}
        </p>
        <KindLinks db={db} current={kind} />
      </header>
      {kind === 'e2e' && <E2eTests db={db} />}
      {kind === 'api' && <ApiTests db={db} />}
      {kind === 'unit' && <UnitTests db={db} />}
    </div>
  );
}
