/**
 * The code of a test, a tab each so the panel stays short: the test itself,
 * the code it tests (the functions it names or calls; for a test of no
 * function, the endpoints it requests or goes through, with the module its
 * file tests; for an API test of other routes, the code that answers them),
 * and the helpers it calls with the step definitions of a scenario, each
 * opened in place. The
 * helpers the test calls itself are listed, those they call folded under
 * them. The tab, the item of 「テスト対象」 and its source are the detail's
 * (TestDetail): they stay as the reader moves between the tabs, and a name
 * in the head of the test opens its code here.
 */
import type { CodeRef, HelperRef, TestCase, TestEntry } from '@maronn-openid-connect/test-catalog/model';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { splitPath } from '../lib/data';
import { textOf } from '../lib/filter';
import { descendants, flatten, helperTree, type HelperNode } from '../lib/helpers';
import { codeKey, initialItem, outsideRequests, testedCode } from '../lib/targets';
import { useApp } from './app-context';
import { RefView, TestedCodeView, type TestedChoice } from './CodeRefs';
import { CodeView } from './CodeView';
import { OutsideLine } from './Target';
import { Tabs, Words } from './ui';

export type CodeTab = 'test' | 'target' | 'helpers';

/** What the detail of a test keeps of its code (TestDetail). */
export interface CodeState extends TestedChoice {
  tab: CodeTab;
  onTab: (tab: CodeTab) => void;
  /** Counts the requests to bring the code into view: a name of the head was chosen. */
  focus: number;
}

/** A helper or a step definition: a row that opens its code under it; `depth` indents a helper under the one that calls it. */
function CodeItem({ label, kind, code, open, onToggle, missing, depth = 0, children }: { label: ReactNode; kind: string; code: CodeRef | undefined; open: boolean; onToggle: () => void; missing: string; depth?: number; children?: ReactNode }) {
  const indent = depth > 0 ? { paddingLeft: `${depth * 20}px` } : undefined;
  if (code === undefined) {
    return (
      <li className="code-item">
        <div className="code-item-head code-item-static" style={indent}>
          <span className="code-item-label">{label}</span>
          <span className="code-item-where">{missing}</span>
        </div>
        {children}
      </li>
    );
  }
  const { name } = splitPath(code.file);
  return (
    <li className={open ? 'code-item code-item-open' : 'code-item'}>
      <button type="button" className="code-item-head" aria-expanded={open} onClick={onToggle} style={indent}>
        <span className="chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="code-item-label">{label}</span>
        <span className="code-item-where" title={code.file}>
          {name}
          <span className="num">
            {' '}
            {code.lines[0]}–{code.lines[1]}
          </span>
        </span>
      </button>
      {open && (
        <div className="code-item-body">
          <RefView
            code={code}
            caption={
              <span className="code-what">
                <span className="code-kind">{kind}</span>
              </span>
            }
            missing={missing}
          />
        </div>
      )}
      {children}
    </li>
  );
}

/** A helper's row. */
function HelperItem({ node, depth, open, onToggle, children }: { node: HelperNode; depth?: number; open: boolean; onToggle: () => void; children?: ReactNode }) {
  const { helper } = node;
  return (
    <CodeItem kind={`ヘルパー ${helper.name}`} label={<span className="mono">{helper.name}</span>} code={helper} open={open} onToggle={onToggle} missing="コードが見つかりません" depth={depth}>
      {children}
    </CodeItem>
  );
}

/** The helpers the test calls itself, each with those it calls folded under it (「providerContext の中で呼ぶ 5 件」). */
function HelperList({ helpers }: { helpers: readonly HelperRef[] }) {
  const roots = useMemo(() => helperTree(helpers), [helpers]);
  const [open, setOpen] = useState<number | undefined>(undefined);
  const [unfolded, setUnfolded] = useState<ReadonlySet<number>>(() => new Set());
  const toggle = (index: number) => setOpen(open === index ? undefined : index);
  const fold = (index: number) =>
    setUnfolded((previous) => {
      const next = new Set(previous);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  return (
    <ul className="code-items">
      {roots.map((node) => {
        const count = descendants(node);
        const shown = unfolded.has(node.index);
        return (
          <HelperItem key={node.index} node={node} open={open === node.index} onToggle={() => toggle(node.index)}>
            {count > 0 && (
              <div className="helper-fold">
                <button type="button" className="helper-fold-button" aria-expanded={shown} onClick={() => fold(node.index)}>
                  <span className="chevron" aria-hidden="true">
                    {shown ? '▾' : '▸'}
                  </span>
                  <span>
                    <span className="mono">{node.helper.name}</span> の中で呼ぶ <span className="num">{count}</span> 件
                  </span>
                </button>
                {shown && (
                  <ul className="code-items code-items-nested">
                    {flatten(node).map(({ node: child, depth }) => (
                      <HelperItem key={child.index} node={child} depth={depth} open={open === child.index} onToggle={() => toggle(child.index)} />
                    ))}
                  </ul>
                )}
              </div>
            )}
          </HelperItem>
        );
      })}
    </ul>
  );
}

function Helpers({ card }: { card: TestCase | Error | undefined }) {
  const { db, lang } = useApp();
  const [open, setOpen] = useState<number | undefined>(undefined);
  if (card === undefined) return <p className="note">読み込んでいます…</p>;
  if (card instanceof Error) return <p className="note">{card.message}</p>;
  const helpers = card.helpers ?? [];
  const steps = card.steps ?? [];
  if (steps.length === 0 && helpers.length === 0) {
    return <p className="note">{db.hasCode ? 'このテストが呼ぶヘルパーはありません。' : 'このデータにはヘルパーの情報がありません。データを作り直すと表示されます。'}</p>;
  }
  return (
    <div className="helpers">
      {steps.length > 0 && (
        <section className="helper-group" aria-label="ステップの定義">
          <h4 className="helper-title">ステップの定義</h4>
          <ul className="code-items">
            {steps.map((step, index) => (
              <CodeItem
                key={index}
                kind="ステップの定義"
                label={
                  <>
                    <span className="step-keyword">{step.keyword.trim()}</span> <Words text={textOf(step, lang)} />
                  </>
                }
                code={step.definition}
                open={open === index}
                onToggle={() => setOpen(open === index ? undefined : index)}
                missing="定義が見つかりません"
              />
            ))}
          </ul>
        </section>
      )}
      {helpers.length > 0 && (
        <section className="helper-group" aria-label="ヘルパー">
          {steps.length > 0 && <h4 className="helper-title">ステップの定義が呼ぶヘルパー</h4>}
          <HelperList helpers={helpers} />
        </section>
      )}
    </div>
  );
}

function TargetTab({ entry, card, state }: { entry: TestEntry; card: TestCase | undefined; state: CodeState }) {
  const { db, source, view } = useApp();
  const items = testedCode(db, entry, card, source);
  const outside = outsideRequests(entry, card);
  // Opened over the page of an endpoint, an E2E or API test shows that endpoint first.
  const chosen = state.chosen !== undefined && items.some((item) => codeKey(item) === state.chosen) ? state.chosen : initialItem(items, view.page === 'endpoint' ? view.endpoint : undefined);
  return (
    <>
      {!db.hasCode && items.length > 0 && <p className="note tested-hint">このデータには関数とエンドポイントのコードの範囲がありません。データを作り直すと表示されます。</p>}
      {/* An API test of routes that are no endpoint of the OP: those routes, introducing the code that answers them (「ルートの実装」) or the functions it tests. */}
      {items.length > 0 && <OutsideLine requests={outside} className="tested-outside" />}
      <TestedCodeView
        items={items}
        empty={outside.length > 0 ? 'このテストのリクエストに答えるコードは分かりませんでした。' : 'このテストが何を確かめているか（関数やエンドポイント）は分かりませんでした。'}
        choice={{ ...state, chosen }}
      />
    </>
  );
}

/** The label of the tab of the helpers: what it holds, muted when it holds nothing. */
function helpersTab(entry: TestEntry, card: TestCase | undefined): { label: string; quiet: boolean } {
  const scenario = entry.form === 'feature' || (card?.steps ?? []).length > 0;
  if (card === undefined) return { label: scenario ? 'ステップ' : 'ヘルパー', quiet: false };
  const helpers = card.helpers?.length ?? 0;
  if (!scenario) return { label: `ヘルパー（${helpers}）`, quiet: helpers === 0 };
  const steps = (card.steps ?? []).filter((step) => step.definition !== undefined).length;
  return { label: helpers > 0 ? `ステップ ${steps} · ヘルパー ${helpers}` : `ステップ（${steps}）`, quiet: steps + helpers === 0 };
}

export function TestCode({ entry, card, lines, state }: { entry: TestEntry; card: TestCase | Error | undefined; lines?: [number, number]; state: CodeState }) {
  const panelId = `code-${useId().replace(/[^\w-]/g, '')}`;
  const area = useRef<HTMLElement>(null);
  const full = card instanceof Error ? undefined : card;
  // A test of a tool tests no function or endpoint of the provider: it has no 「テスト対象」.
  const targets = entry.kind !== 'tool';
  const tab: CodeTab = !targets && state.tab === 'target' ? 'test' : state.tab;
  const helpers = helpersTab(entry, full);
  const options = [
    { value: 'test' as const, label: 'テスト' },
    ...(targets ? [{ value: 'target' as const, label: 'テスト対象' }] : []),
    { value: 'helpers' as const, label: helpers.label, quiet: helpers.quiet },
  ];

  // A name of the head opened some code: bring the section to the top (under the bar or the header), and keep it there while
  // its code arrives and the page grows enough to scroll that far, until the reader scrolls or a moment has passed.
  useEffect(() => {
    const section = area.current;
    if (state.focus === 0 || section === null) return undefined;
    const bring = () => section.scrollIntoView({ block: 'start' });
    bring();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(bring);
    observer?.observe(section);
    const stop = () => {
      observer?.disconnect();
      window.removeEventListener('wheel', stop);
      window.removeEventListener('touchstart', stop);
      window.removeEventListener('keydown', stop);
    };
    window.addEventListener('wheel', stop, { passive: true });
    window.addEventListener('touchstart', stop, { passive: true });
    window.addEventListener('keydown', stop);
    const timer = window.setTimeout(stop, 1500);
    return () => {
      window.clearTimeout(timer);
      stop();
    };
  }, [state.focus]);

  return (
    <section className="detail-section code-area" aria-label="コード" ref={area}>
      <h3>コード</h3>
      <Tabs label="コード" options={options} value={tab} onChange={state.onTab} panelId={panelId} />
      <div className="tab-panel" role="tabpanel" id={panelId} aria-labelledby={`${panelId}-${tab}`}>
        {tab === 'test' && <CodeView path={entry.file} lines={lines} />}
        {tab === 'target' && <TargetTab entry={entry} card={full} state={state} />}
        {tab === 'helpers' && <Helpers card={card} />}
      </div>
    </section>
  );
}
