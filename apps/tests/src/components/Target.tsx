/**
 * What a test tests, in a line: the functions of a unit test, the functions
 * and the endpoints (METHOD path) of an API test, the route of an E2E test
 * (the paths joined by arrows, the endpoints its code requests in full and
 * those it only passes through muted). On the page of an endpoint, that
 * endpoint is in bold. In the head of a test each name is a quiet button
 * that opens its code (`onPick`); in a row on a phone a route says only the
 * endpoints the test requests and how long it is (`compact`).
 */
import { Fragment, type ReactNode } from 'react';
import type { RouteStep, Target, TargetFunction } from '../lib/targets';

/** How many functions a line names before 「ほか n 件」. */
const FIRST_FUNCTIONS = 3;

type Pick = ((key: string) => void) | undefined;

/** A name of the line: a span, or a quiet button that opens its code in 「テスト対象」; its title says what it is (`label`, and a `note`). */
function Name({ itemKey, className, label, note, pick, children }: { itemKey: string; className: string; label: string; note?: string; pick: Pick; children: ReactNode }) {
  const after = note === undefined ? '' : `（${note}）`;
  if (pick === undefined) {
    return (
      <span className={className} title={`${label}${after}`}>
        {children}
      </span>
    );
  }
  return (
    <button type="button" className={`${className} target-pick`} title={`${label} のコードを見る${after}`} onClick={() => pick(itemKey)}>
      {children}
    </button>
  );
}

function Functions({ functions, pick }: { functions: readonly TargetFunction[]; pick: Pick }) {
  const shown = functions.slice(0, FIRST_FUNCTIONS);
  const rest = functions.length - shown.length;
  const next = functions[FIRST_FUNCTIONS];
  return (
    <>
      {shown.map((fn, index) => (
        <Fragment key={fn.id}>
          {index > 0 && <span className="target-sep">, </span>}
          <Name itemKey={`function:${fn.id}`} className="target-fn" label={fn.name} note={fn.qualifier} pick={pick}>
            {fn.name}
            {fn.qualifier !== undefined && <span className="target-qualifier">（{fn.qualifier}）</span>}
          </Name>
        </Fragment>
      ))}
      {rest > 0 &&
        (pick === undefined || next === undefined ? (
          <span className="target-more"> ほか {rest} 件</span>
        ) : (
          <>
            {' '}
            <button type="button" className="target-more target-pick" onClick={() => pick(`function:${next.id}`)}>
              ほか {rest} 件
            </button>
          </>
        ))}
    </>
  );
}

/** One endpoint of the line; one the test only passes through is muted, the page's own in bold. */
function Step({ step, methods, current, pick }: { step: RouteStep; methods: boolean; current?: string; pick: Pick }) {
  const className = `target-step${step.id === current ? ' target-current' : ''}${step.named ? '' : ' target-passed'}`;
  const label = `${methods && step.methods.length > 0 ? `${step.methods.join(' · ')} ` : ''}${step.path}`;
  return (
    <Name itemKey={`endpoint:${step.id}`} className={className} label={label} note={step.named ? undefined : '実行で通っただけ'} pick={pick}>
      {methods && step.methods.length > 0 && <span className="target-method">{step.methods.join(' · ')} </span>}
      {step.path}
    </Name>
  );
}

/** Endpoints joined by arrows (a route) or commas, with the methods of each (the requests of an API test) or without. */
function Steps({ steps, route, methods, current, pick }: { steps: readonly RouteStep[]; route: boolean; methods: boolean; current?: string; pick: Pick }) {
  return (
    <>
      {steps.map((step, index) => (
        <Fragment key={`${step.id}-${index}`}>
          {index > 0 && (route ? <span className="target-arrow"> → </span> : <span className="target-sep">, </span>)}
          <Step step={step} methods={methods} current={current} pick={pick} />
        </Fragment>
      ))}
    </>
  );
}

export function TargetText({ target, current, onPick, compact }: { target: Target; current?: string; onPick?: (key: string) => void; compact?: boolean }) {
  if (target.kind === 'functions') {
    return (
      <span className="target-text">
        <Functions functions={target.functions} pick={onPick} />
      </span>
    );
  }
  if (target.kind === 'endpoints') {
    return (
      <span className="target-text">
        {target.functions.length > 0 && (
          <>
            <Functions functions={target.functions} pick={onPick} />
            <span className="target-sep"> · </span>
          </>
        )}
        <Steps steps={target.steps} route={false} methods current={current} pick={onPick} />
      </span>
    );
  }
  const named = target.steps.filter((step) => step.named);
  const full = <Steps steps={target.steps} route methods={false} current={current} pick={onPick} />;
  // On a phone a row says the endpoints the test requests and how long its route is; the head of a test always shows the whole route.
  if (compact !== true || named.length === 0 || named.length === target.steps.length) return <span className="target-text">{full}</span>;
  return (
    <span className="target-text">
      <span className="route-full">{full}</span>
      <span className="route-short">
        <Steps steps={named} route={false} methods={false} current={current} pick={onPick} />
        <span className="target-more"> · 経路 {target.steps.length}</span>
      </span>
    </span>
  );
}

/** The line under a title: 「対象」 and the target. */
export function TargetLine({ target, current, className, onPick, compact }: { target: Target; current?: string; className?: string; onPick?: (key: string) => void; compact?: boolean }) {
  return (
    <span className={className ?? 'row-target'}>
      <span className="target-label">対象</span>
      <TargetText target={target} current={current} onPick={onPick} compact={compact} />
    </span>
  );
}
