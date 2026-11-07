/**
 * The code of what a test tests and of what it uses: a range of a file
 * with a caption that says what it is (「関数 authenticateTokenClient」,
 * 「エンドポイント POST /token（Hono）」, 「手順のコード」, 「ルートの実装
 * WebRouter」) and where it is, and the switch between the functions or
 * endpoints of a test (and hono / Next.js).
 */
import type { CodeRef } from '@maronn-openid-connect/test-catalog/model';
import type { ReactNode } from 'react';
import { formatCode, withoutPanel, type CodeTarget, type Source } from '../lib/route';
import { codeKey, type TestedCode } from '../lib/targets';
import { useApp } from './app-context';
import { CodeView } from './CodeView';
import { ROUTE_CODE_LABEL } from './Target';
import { Chips, CodeIcon, Segmented, Words } from './ui';

export const SOURCE_NAMES: Record<Source, string> = { hono: 'Hono', nextjs: 'Next.js' };

/** Where a range is: its file and its lines. */
export function Where({ code }: { code: CodeRef }) {
  return (
    <span className="code-where" title={code.file}>
      {code.file}
      <span className="num">
        {' '}
        {code.lines[0]}–{code.lines[1]} 行
      </span>
    </span>
  );
}

/** A range of a file with what it is above it; one muted line in its place when the data has no range. */
export function RefView({ code, caption, missing }: { code: CodeRef | undefined; caption: ReactNode; missing: string }) {
  if (code === undefined) {
    return (
      <div className="code code-missing">
        <div className="code-bar">
          <div className="code-caption">{caption}</div>
        </div>
        <p className="note code-note">{missing}</p>
      </div>
    );
  }
  return (
    <CodeView
      key={`${code.file}:${code.lines[0]}:${code.lines[1]}`}
      path={code.file}
      lines={code.lines}
      scope="range"
      caption={
        <>
          {caption}
          <Where code={code} />
        </>
      }
    />
  );
}

/** The caption of code a heading above already names: what kind of code it is. */
function KindOnly({ kind }: { kind: string }) {
  return (
    <span className="code-what">
      <span className="code-kind">{kind}</span>
    </span>
  );
}

/** The caption of a function: 「関数 name」 and its summary. */
function FunctionCaption({ name, summary }: { name: string; summary?: string }) {
  return (
    <>
      <span className="code-what">
        <span className="code-kind">関数</span>
        <span className="code-name mono">{name}</span>
      </span>
      {summary !== undefined && summary !== '' && (
        <span className="code-summary">
          <Words text={summary} />
        </span>
      )}
    </>
  );
}

/** The caption of an endpoint: 「エンドポイント METHOD path（Hono）」. */
function EndpointCaption({ methods, path, source }: { methods: readonly string[]; path: string; source: Source }) {
  return (
    <span className="code-what">
      <span className="code-kind">エンドポイント</span>
      <span className="code-name mono">
        {methods.length > 0 && `${methods.join(' · ')} `}
        {path}
      </span>
      <span className="code-source">（{SOURCE_NAMES[source]}）</span>
    </span>
  );
}

/** The caption of the code that answers an API test's requests to routes that are no endpoint: 「ルートの実装 name」. */
function RouteCodeCaption({ name }: { name: string }) {
  return (
    <span className="code-what">
      <span className="code-kind">{ROUTE_CODE_LABEL}</span>
      <span className="code-name mono">{name}</span>
    </span>
  );
}

/** What a chip of 「テスト対象」 says, and its title. */
function chipOf(item: TestedCode): { label: string; title: string } {
  if (item.kind === 'function') return { label: item.name, title: `関数 ${item.name}` };
  if (item.kind === 'block') return { label: '手順のコード', title: `手順「${item.name}」のコード` };
  if (item.kind === 'route-code') return { label: item.name, title: `${ROUTE_CODE_LABEL} ${item.name}` };
  return { label: item.path, title: item.named ? `エンドポイント ${item.path}` : `エンドポイント ${item.path}（このテストは実行で通っただけ）` };
}

/** Which item of some code is shown and on which source: the state a test keeps across its tabs, or the panel of some code keeps. */
export interface TestedChoice {
  /** The key of the item shown (targets.ts codeKey). */
  chosen: string | undefined;
  onChoose: (key: string) => void;
  side: Source;
  onSide: (side: Source) => void;
}

/**
 * The code of some functions, endpoints and step blocks, one at a time: a
 * chip an item when there are several (an endpoint the test only passes
 * through muted), and hono / Next.js when an endpoint was tested on both.
 * With `named` the heading above already names the one item, and the
 * caption says only where the code is.
 */
export function TestedCodeView({ items, empty, named, choice }: { items: readonly TestedCode[]; empty: ReactNode; named?: boolean; choice: TestedChoice }) {
  if (items.length === 0) return <p className="note tested-empty">{empty}</p>;
  const found = items.findIndex((candidate) => codeKey(candidate) === choice.chosen);
  const item = items[found === -1 ? 0 : found] as TestedCode;
  const version = item.kind === 'endpoint' ? (item.versions.find((candidate) => candidate.source === choice.side) ?? item.versions[0]) : undefined;
  const options = items.map((candidate) => {
    const chip = chipOf(candidate);
    return { value: codeKey(candidate), label: <span className={candidate.kind === 'block' ? undefined : 'mono'}>{chip.label}</span>, title: chip.title, quiet: candidate.kind === 'endpoint' && !candidate.named };
  });
  const alone = named === true && items.length === 1;
  return (
    <div className="tested-code">
      {(items.length > 1 || (item.kind === 'endpoint' && item.versions.length > 1)) && (
        <div className="tested-switches">
          {items.length > 1 && <Chips label="対象" options={options} value={codeKey(item)} onChange={choice.onChoose} />}
          {item.kind === 'endpoint' && item.versions.length > 1 && version !== undefined && (
            <Segmented<Source>
              size="small"
              label="ソース"
              options={item.versions.map((candidate) => ({ value: candidate.source, label: SOURCE_NAMES[candidate.source] }))}
              value={version.source}
              onChange={choice.onSide}
            />
          )}
        </div>
      )}
      {item.kind === 'function' ? (
        <RefView code={item.code} caption={alone ? <KindOnly kind="関数" /> : <FunctionCaption name={item.name} summary={item.summary} />} missing={`${item.name} のコードはデータにありません。`} />
      ) : item.kind === 'route-code' ? (
        <RefView code={item.code} caption={<RouteCodeCaption name={item.name} />} missing={`${item.name} のコードはデータにありません。`} />
      ) : item.kind === 'block' ? (
        <RefView code={item.code} caption={<KindOnly kind="手順のコード" />} missing={`「${item.name}」のコードはデータにありません。`} />
      ) : version === undefined ? (
        <p className="note">{item.path} のコードはデータにありません。</p>
      ) : (
        <RefView
          code={version.code}
          caption={alone && item.versions.length === 1 ? <KindOnly kind="エンドポイントの本体" /> : <EndpointCaption methods={version.methods} path={item.path} source={version.source} />}
          missing={`${version.label}（${SOURCE_NAMES[version.source]}）のコードはデータにありません。`}
        />
      )}
    </div>
  );
}

/**
 * A quiet button that opens some code in the panel over the page: the body
 * of an endpoint, the code of a step, a function. With `text` it says so
 * (「コード」, the one word every such button has); without, it is the icon
 * alone (the dense timeline of the steps), named for a screen reader.
 */
export function CodeButton({ target, label, text, className }: { target: CodeTarget; label: string; text?: string; className?: string }) {
  const { view, go } = useApp();
  return (
    <button
      type="button"
      className={`code-button${text === undefined ? ' code-button-icon' : ''}${className === undefined ? '' : ` ${className}`}`}
      aria-label={text === undefined ? label : undefined}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        go({ ...withoutPanel(view), code: formatCode(target) });
      }}
    >
      <CodeIcon />
      {text !== undefined && <span>{text}</span>}
    </button>
  );
}
