/**
 * The tests of one kind, by what they test, each row saying it:
 *
 * - E2E by their file, each with the route of endpoints it goes through;
 * - API by the endpoint they request, on the chosen source;
 * - unit by package, then module and function, folded: a module opens on
 *   its functions with their counts, a function on its tests, and a
 *   function's code opens in the panel.
 *
 * The three kinds are links at the top, so the reader moves between them.
 */
import type { TestEntry } from '@maronn-openid-connect/test-catalog/model';
import { Fragment, useMemo, useState } from 'react';
import { KIND_LABELS, KIND_NAMES, KIND_NOTES, splitPath, type Db } from '../lib/data';
import { filterTests } from '../lib/filter';
import { formatCount } from '../lib/format';
import { apiEndpoints, e2eFiles, testsOfKind, unitPackages, type UnitFunction, type UnitModule } from '../lib/kinds';
import { formatHash, MAIN_KINDS, type MainKind, type OutcomeFilter } from '../lib/route';
import { useApp, useTitle } from './app-context';
import { CodeButton, SOURCE_NAMES } from './CodeRefs';
import { OutcomeFilterControl, rowOf, Rows } from './TestList';
import { Chips, SourceSwitch, Words } from './ui';

/** A package with more modules than this opens with its modules folded. */
const OPEN_MODULES = 8;

/** The three kinds as links, the current one marked. */
function KindLinks({ db, current }: { db: Db; current: MainKind }) {
  return (
    <nav className="kind-links" aria-label="テストの種類">
      {MAIN_KINDS.map((kind) => (
        <a key={kind} href={formatHash({ page: 'kind', testKind: kind })} aria-current={kind === current ? 'page' : undefined}>
          <span className={`swatch part-${kind}`} aria-hidden="true" />
          {KIND_LABELS[kind]}
          <span className="kind-link-count num">{formatCount(db.index.counts.kinds?.[kind] ?? 0)}</span>
        </a>
      ))}
    </nav>
  );
}

function useOutcome(): OutcomeFilter {
  return useApp().view.outcome ?? 'both';
}

function E2eTests({ db }: { db: Db }) {
  const outcome = useOutcome();
  const files = useMemo(() => e2eFiles(db), [db]);
  const groups = files.map((file) => ({ ...file, tests: filterTests(file.tests, { outcome }) })).filter((file) => file.tests.length > 0);
  return (
    <>
      <div className="filters">
        <OutcomeFilterControl />
      </div>
      {groups.length === 0 && <p className="note">該当するテストはありません</p>}
      <div className="kind-groups">
        {groups.map((file) => (
          <section key={file.file} className="kind-group" aria-label={file.title}>
            <div className="kind-group-head">
              <h2 className="kind-group-title">{file.title}</h2>
              <span className="kind-group-count num">{formatCount(file.tests.length)}</span>
              <a className="kind-group-file" href={formatHash({ page: 'file', file: file.file })} title={file.file}>
                {splitPath(file.file).name}
              </a>
            </div>
            <Rows key={outcome} rows={file.tests.map(rowOf)} hideFile target={{}} />
          </section>
        ))}
      </div>
    </>
  );
}

function ApiTests({ db }: { db: Db }) {
  const { source } = useApp();
  const outcome = useOutcome();
  const groups = useMemo(() => apiEndpoints(db, source), [db, source]);
  const shown = groups.endpoints.map((group) => ({ ...group, tests: filterTests(group.tests, { outcome }) })).filter((group) => group.tests.length > 0);
  const other = filterTests(groups.other, { outcome });
  return (
    <>
      {/* On a phone the source (in the header on a desk) and the outcome share a row. */}
      <div className="filters filters-api">
        <SourceSwitch place="body" />
        <OutcomeFilterControl />
      </div>
      {shown.length === 0 && other.length === 0 && <p className="note">{SOURCE_NAMES[source]} の該当するテストはありません</p>}
      <div className="kind-groups">
        {shown.map(({ endpoint, tests }) => (
          <section key={endpoint.key} className="kind-group" aria-label={endpoint.label}>
            <div className="kind-group-head">
              <h2 className="kind-group-title">
                <a href={formatHash({ page: 'endpoint', source: endpoint.source, endpoint: endpoint.id })}>{endpoint.label}</a>
              </h2>
              <span className="kind-group-count num">{formatCount(tests.length)}</span>
              <span className="kind-group-path">
                <span className="method">{endpoint.methods.join(' · ')}</span> {endpoint.path}
              </span>
              {endpoint.code !== undefined && <CodeButton target={{ kind: 'endpoint', key: endpoint.key }} label={`${endpoint.label}（${SOURCE_NAMES[endpoint.source]}）のコードを見る`} text="コード" />}
            </div>
            <Rows key={outcome} rows={tests.map(rowOf)} target={{ current: endpoint.id }} />
          </section>
        ))}
        {other.length > 0 && (
          <section className="kind-group" aria-label="エンドポイントの分からないテスト">
            <div className="kind-group-head">
              <h2 className="kind-group-title">エンドポイントの分からないテスト</h2>
              <span className="kind-group-count num">{formatCount(other.length)}</span>
            </div>
            <Rows key={outcome} rows={other.map(rowOf)} target={{}} />
          </section>
        )}
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
function UnitFunctionItem({ db, fn, tests, alone }: { db: Db; fn: UnitFunction; tests: TestEntry[]; alone: boolean }) {
  const [open, setOpen] = useState(alone);
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
          <Rows rows={tests.map(rowOf)} target={{ known: [fn.id] }} />
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
function UnitModuleItem({ db, module, keep, startOpen }: { db: Db; module: UnitModule; keep: (entry: TestEntry) => boolean; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const groups = module.functions.map((fn) => ({ fn, tests: fn.tests.filter(keep) })).filter((group) => group.tests.length > 0);
  if (groups.length === 0) return null;
  const count = new Set(groups.flatMap((group) => group.tests.map((test) => test.id))).size;
  return (
    <details className="unit-module" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="unit-module-head">
        <span className="chevron" aria-hidden="true" />
        <span className="unit-module-path mono">
          <PathText path={module.module} />
        </span>
        <span className="kind-group-count num">{formatCount(count)}</span>
        {!open && <span className="unit-module-fns">関数 {formatCount(groups.length)}</span>}
      </summary>
      {open && (
        <ul className="unit-fns">
          {groups.map((group) => (
            <UnitFunctionItem key={group.fn.id} db={db} fn={group.fn} tests={group.tests} alone={groups.length === 1} />
          ))}
        </ul>
      )}
    </details>
  );
}

/** The unit tests of a package whose function the reader could not find, folded like a module. */
function UnknownItem({ tests }: { tests: TestEntry[] }) {
  const [open, setOpen] = useState(false);
  if (tests.length === 0) return null;
  return (
    <details className="unit-module" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="unit-module-head">
        <span className="chevron" aria-hidden="true" />
        <span className="unit-module-path">関数の分からないテスト</span>
        <span className="kind-group-count num">{formatCount(tests.length)}</span>
      </summary>
      {open && (
        <div className="unit-fn-tests">
          <Rows rows={tests.map(rowOf)} target={{}} />
        </div>
      )}
    </details>
  );
}

function UnitTests({ db }: { db: Db }) {
  const { view, go } = useApp();
  const outcome = useOutcome();
  const packages = useMemo(() => unitPackages(db), [db]);
  const pkg = packages.find((candidate) => candidate.name === view.pkg) ?? packages[0];
  const keep = useMemo(() => (entry: TestEntry) => outcome === 'both' || entry.outcome === outcome, [outcome]);
  if (pkg === undefined) return <p className="note">ユニットテストはありません</p>;
  const unknown = pkg.unknown.filter(keep);
  const shown = pkg.modules.some((module) => module.functions.some((fn) => fn.tests.some(keep))) || unknown.length > 0;
  return (
    <>
      <div className="filters filters-unit">
        <Chips
          label="パッケージ"
          options={packages.map((candidate) => ({ value: candidate.name, label: candidate.name, count: candidate.count }))}
          value={pkg.name}
          onChange={(value) => go({ ...view, pkg: value === packages[0]?.name ? undefined : value }, { replace: true })}
        />
        <OutcomeFilterControl />
      </div>
      <p className="unit-note">モジュールを開くと関数が、関数を開くとそのテストが出ます。関数のテストは、その関数を describe に書いたテストと、期待値で結果を確かめているテストです。</p>
      {shown ? (
        <div key={`${pkg.name}:${outcome}`} className="unit-modules">
          {pkg.modules.map((module) => (
            <UnitModuleItem key={module.module} db={db} module={module} keep={keep} startOpen={pkg.modules.length <= OPEN_MODULES} />
          ))}
          <UnknownItem tests={unknown} />
        </div>
      ) : (
        <p className="note">該当するテストはありません</p>
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
