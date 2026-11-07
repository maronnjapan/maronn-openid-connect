/**
 * What a test tests, in a line: the functions of a unit test; the endpoints
 * (METHOD path) of an API test, then its functions; the route of an E2E test
 * (the paths joined by arrows, the endpoints its code requests in full and
 * those it only passes through muted), then its functions. An API test of
 * routes that are no endpoint of the OP names the code that answers them
 * (「ルートの実装」, from its card) among what it tests, and its requests to
 * them follow under a label that says why they reach no endpoint:
 * 「テストのルート」 (a route the test registers itself), 「アプリのルート」
 * (`/health`, the operator's API) or 「パスは実行時に決まる」, muted. On the
 * page of an endpoint, that endpoint is in bold, and first among the
 * endpoints of a test of many. In the head of a test each name is a quiet
 * button that opens its code (`onPick`); in a row on a phone a route says
 * only the endpoints the test requests and how long it is (`compact`).
 */
import type { RequestRoute } from '@maronn-openid-connect/test-catalog/model';
import { Fragment, type ReactNode } from 'react';
import { byRoute, type OutsideRequest, type RouteStep, type Target, type TargetFunction } from '../lib/targets';

/** How many functions a line names before 「ほか n 件」. */
const FIRST_FUNCTIONS = 3;

/** How many endpoints an API test's line names before 「ほか n 件」 (a test of a table requests many). */
const FIRST_STEPS = 3;

/** How many requests to other routes a row names before 「ほか n 件」. */
const FIRST_OUTSIDE = 3;

/** Why a request reaches no endpoint of the OP, as the label of its requests. */
export const ROUTE_LABELS: Record<RequestRoute, string> = { own: 'テストのルート', app: 'アプリのルート', unknown: 'パスは実行時に決まる' };

/** What each label means, for a title and a screen reader. */
export const ROUTE_NOTES: Record<RequestRoute, string> = {
  own: 'テストが自分で登録したルートへのリクエスト',
  app: 'アプリの、OP のエンドポイントではないルートへのリクエスト',
  unknown: 'パスがテストを動かすまで分からないリクエスト',
};

/** What the code that answers the requests to other routes is called. */
export const ROUTE_CODE_LABEL = 'ルートの実装';

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

/** 「ほか n 件」 after the first few names: a button to the next one's code in the head of a test, muted text in a row. */
function More({ rest, next, pick }: { rest: number; next: string | undefined; pick: Pick }) {
  if (rest <= 0) return null;
  if (pick === undefined || next === undefined) return <span className="target-more"> ほか {rest} 件</span>;
  return (
    <>
      {' '}
      <button type="button" className="target-more target-pick" onClick={() => pick(next)}>
        ほか {rest} 件
      </button>
    </>
  );
}

/** The code that answers an API test's requests to other routes, then the functions it tests. */
function Functions({ functions, routeCode, pick }: { functions: readonly TargetFunction[]; routeCode?: string; pick: Pick }) {
  const shown = functions.slice(0, FIRST_FUNCTIONS);
  return (
    <>
      {routeCode !== undefined && (
        <Name itemKey={`route-code:${routeCode}`} className="target-fn" label={routeCode} note={ROUTE_CODE_LABEL} pick={pick}>
          {routeCode}
        </Name>
      )}
      {shown.map((fn, index) => (
        <Fragment key={fn.id}>
          {(index > 0 || routeCode !== undefined) && <span className="target-sep">, </span>}
          <Name itemKey={`function:${fn.id}`} className="target-fn" label={fn.name} note={fn.qualifier} pick={pick}>
            {fn.name}
            {fn.qualifier !== undefined && <span className="target-qualifier">（{fn.qualifier}）</span>}
          </Name>
        </Fragment>
      ))}
      <More rest={functions.length - shown.length} next={functions[FIRST_FUNCTIONS] === undefined ? undefined : `function:${functions[FIRST_FUNCTIONS]?.id}`} pick={pick} />
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

/**
 * Endpoints joined by arrows (a route, every one in its order) or commas
 * (the requests of an API test: the page's endpoint first, the first few,
 * then 「ほか n 件」), with the methods of each or without.
 */
function Steps({ steps, route, methods, current, pick }: { steps: readonly RouteStep[]; route: boolean; methods: boolean; current?: string; pick: Pick }) {
  const ordered = route || current === undefined ? steps : [...steps.filter((step) => step.id === current), ...steps.filter((step) => step.id !== current)];
  const shown = route ? ordered : ordered.slice(0, FIRST_STEPS);
  const next = ordered[shown.length];
  return (
    <>
      {shown.map((step, index) => (
        <Fragment key={`${step.id}-${index}`}>
          {index > 0 && (route ? <span className="target-arrow"> → </span> : <span className="target-sep">, </span>)}
          <Step step={step} methods={methods} current={current} pick={pick} />
        </Fragment>
      ))}
      <More rest={ordered.length - shown.length} next={next === undefined ? undefined : `endpoint:${next.id}`} pick={pick} />
    </>
  );
}

/** Some requests to other routes of one kind: `GET /health, POST /token`; of paths known at run time, their methods. The first few in a row (`limit`). */
function RouteRequests({ requests, limit }: { requests: readonly OutsideRequest[]; limit?: number }) {
  const shown = limit === undefined ? requests : requests.slice(0, limit);
  return (
    <>
      {shown.map((request, index) => (
        <Fragment key={`${request.method} ${request.path}`}>
          {index > 0 && <span className="target-sep">, </span>}
          <span className="target-step">
            {request.path === '' ? (
              <span className="target-method">{request.method}</span>
            ) : (
              <>
                <span className="target-method">{request.method} </span>
                {request.path}
              </>
            )}
          </span>
        </Fragment>
      ))}
      {requests.length > shown.length && <span className="target-more"> ほか {requests.length - shown.length} 件</span>}
    </>
  );
}

/** The functions after the endpoints of an API or E2E test, and the code that answers an API test's other routes. */
function AfterSteps({ functions, routeCode, pick }: { functions: readonly TargetFunction[] | undefined; routeCode?: string; pick: Pick }) {
  if ((functions === undefined || functions.length === 0) && routeCode === undefined) return null;
  return (
    <>
      <span className="target-sep"> · </span>
      <Functions functions={functions ?? []} routeCode={routeCode} pick={pick} />
    </>
  );
}

/** Whether a target says anything besides its requests to other routes (an API test of no endpoint, no function and no code that answers it says only those). */
export function hasMainTarget(target: Target): boolean {
  return target.kind !== 'functions' || target.functions.length > 0 || target.routeCode !== undefined;
}

export function TargetText({ target, current, onPick, compact }: { target: Target; current?: string; onPick?: (key: string) => void; compact?: boolean }) {
  if (target.kind === 'functions') {
    return (
      <span className="target-text">
        <Functions functions={target.functions} routeCode={target.routeCode} pick={onPick} />
      </span>
    );
  }
  if (target.kind === 'endpoints') {
    return (
      <span className="target-text">
        <Steps steps={target.steps} route={false} methods current={current} pick={onPick} />
        <AfterSteps functions={target.functions} routeCode={target.routeCode} pick={onPick} />
      </span>
    );
  }
  const named = target.steps.filter((step) => step.named);
  const full = <Steps steps={target.steps} route methods={false} current={current} pick={onPick} />;
  const functions = <AfterSteps functions={target.functions} pick={onPick} />;
  // On a phone a row says the endpoints the test requests and how long its route is; the head of a test always shows the whole route.
  if (compact !== true || named.length === 0 || named.length === target.steps.length) {
    return (
      <span className="target-text">
        {full}
        {functions}
      </span>
    );
  }
  return (
    <span className="target-text">
      <span className="route-full">{full}</span>
      <span className="route-short">
        <Steps steps={named} route={false} methods={false} current={current} pick={onPick} />
        <span className="target-more"> · 経路 {target.steps.length}</span>
      </span>
      {functions}
    </span>
  );
}

/**
 * The line under a title: 「対象」 and the target, then the requests of an
 * API test to other routes, each kind under its label (「テストのルート」,
 * 「アプリのルート」, 「パスは実行時に決まる」), the first few; with
 * `outside={false}` without them (the head of a test, whose 「リクエスト」
 * lists every request).
 */
export function TargetLine({ target, current, className, onPick, compact, outside = true }: { target: Target; current?: string; className?: string; onPick?: (key: string) => void; compact?: boolean; outside?: boolean }) {
  const others = outside && target.kind !== 'route' ? byRoute(target.outside ?? []) : [];
  if (!hasMainTarget(target) && others.length === 0) return null;
  return (
    <span className={className ?? 'row-target'}>
      {hasMainTarget(target) && (
        <span className="target-part">
          <span className="target-label">対象</span>
          <TargetText target={target} current={current} onPick={onPick} compact={compact} />
        </span>
      )}
      {others.map((group) => (
        <span key={group.route} className="target-part target-outside" title={`${ROUTE_NOTES[group.route]}：${group.requests.map((request) => `${request.method} ${request.path}`.trim()).join(', ')}`}>
          <span className="target-label">{ROUTE_LABELS[group.route]}</span>
          <span className="target-text">
            <RouteRequests requests={group.requests} limit={FIRST_OUTSIDE} />
          </span>
        </span>
      ))}
    </span>
  );
}

/**
 * The requests of an API test to routes that are no endpoint of the OP, each
 * kind under its label, as a muted line of their own: in 「テスト対象」, above
 * the code that answers them.
 */
export function OutsideLine({ requests, className }: { requests: readonly OutsideRequest[]; className?: string }) {
  const groups = byRoute(requests);
  if (groups.length === 0) return null;
  return (
    <p className={`outside-line${className === undefined ? '' : ` ${className}`}`}>
      {groups.map((group) => (
        <span key={group.route} className="outside-part" title={ROUTE_NOTES[group.route]}>
          <span className="outside-label">{ROUTE_LABELS[group.route]}</span>
          <span className="target-text">
            <RouteRequests requests={group.requests} />
          </span>
        </span>
      ))}
    </p>
  );
}
