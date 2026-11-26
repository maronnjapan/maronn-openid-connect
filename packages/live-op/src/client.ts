/**
 * The pages' side of the live OP (the map and the tests viewer): calls to
 * the control API (`/__live/*`, relay.ts) of the reader's workspace. The
 * pages are served from the origin the OP answers at (the map's Worker,
 * or Vite's dev server that passes the OP's paths on to the Node host), so
 * the calls go to the page's own origin, and the browser's own requests to
 * the OP (a login in another tab) reach the same workspace by its cookie.
 * Only fetch and the types: it imports nothing of the OP.
 */
import {
  LIVE_PREFIX,
  PUBLIC_WORKSPACE,
  WORKSPACE_COOKIE,
  WORKSPACE_HEADER,
  isWorkspaceId,
  type ExchangeSummary,
  type GrantPlan,
  type GrantResult,
  type LiveExchange,
  type LiveRequest,
  type LiveState,
  type PreparedScenario,
  type ProbeTable,
} from './api.js';

/** The key the page keeps the reader's workspace under in localStorage. */
const STORAGE_KEY = 'oidc-map-live-workspace';

/** A new workspace id: 16 random base36 characters. */
function newWorkspaceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `w${[...bytes].map((byte) => (byte % 36).toString(36)).join('')}`;
}

/**
 * The reader's workspace: the one this browser keeps, made on first use.
 * It is also set as a cookie of the origin, so a request the browser sends
 * to the OP's paths itself (a login page opened in a tab) reaches it.
 */
export function readerWorkspace(): string {
  let id: string | undefined;
  try {
    const kept = globalThis.localStorage?.getItem(STORAGE_KEY) ?? undefined;
    if (kept !== undefined && isWorkspaceId(kept)) id = kept;
  } catch {
    // Storage may be unavailable (a private window): the workspace lasts as long as the page.
  }
  if (id === undefined) {
    id = newWorkspaceId();
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, id);
    } catch {
      // As above.
    }
  }
  if (typeof document !== 'undefined') {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${WORKSPACE_COOKIE}=${id}; Path=/; SameSite=Lax; Max-Age=31536000${secure}`;
  }
  return id;
}

/** A failure of the control API: its status and what it said. */
export class LiveOpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The client of a workspace's control API (see the module comment). */
export class LiveOpClient {
  constructor(
    readonly workspace: string = PUBLIC_WORKSPACE,
    /** The origin of the OP; the page's own when absent. */
    readonly origin: string = typeof location === 'undefined' ? 'http://127.0.0.1:3610' : location.origin,
  ) {}

  /** Call the control API and read its JSON answer; a LiveOpError for any other status than 2xx. */
  private async call<T>(route: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(new URL(`${LIVE_PREFIX}${route}`, this.origin), {
        method: init.method ?? 'GET',
        headers: { [WORKSPACE_HEADER]: this.workspace, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch (error) {
      throw new LiveOpError(0, `地図の OP に接続できません（${error instanceof Error ? error.message : String(error)}）。`);
    }
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        const parsed = JSON.parse(text) as { error_description?: string; error?: string };
        message = parsed.error_description ?? parsed.error ?? text;
      } catch {
        // Not JSON.
      }
      throw new LiveOpError(response.status, response.status === 404 && !text.startsWith('{') ? '地図の OP が見つかりません（このページの配信元に OP がありません）。' : message);
    }
    return JSON.parse(text) as T;
  }

  /** Send a request a reader wrote to the OP: the exchange it was recorded as. */
  run(request: LiveRequest): Promise<LiveExchange> {
    return this.call('run', { method: 'POST', body: { request } });
  }

  /** Prepare a case's request on the workspace by the requests that lead up to it. */
  prepare(id: string): Promise<PreparedScenario> {
    return this.call('scenario', { method: 'POST', body: { id } });
  }

  /** Run an authorization as a browser and a client would. */
  grant(plan: GrantPlan): Promise<GrantResult> {
    return this.call('grant', { method: 'POST', body: { plan } });
  }

  /** The exchanges the workspace keeps, oldest first; those after one only, when it is named. */
  exchanges(after?: string): Promise<ExchangeSummary[]> {
    return this.call(`exchanges${after === undefined ? '' : `?after=${encodeURIComponent(after)}`}`);
  }

  /** One exchange, whole. */
  exchange(id: string): Promise<LiveExchange> {
    return this.call(`exchanges/${encodeURIComponent(id)}`);
  }

  /** What the workspace is and holds. */
  state(): Promise<LiveState> {
    return this.call('state');
  }

  /** Start the workspace over. */
  reset(): Promise<LiveState> {
    return this.call('reset', { method: 'POST', body: {} });
  }

  /** Move the OP's clock on. */
  advanceClock(seconds: number): Promise<LiveState> {
    return this.call('clock', { method: 'POST', body: { advanceSeconds: seconds } });
  }

  /** The probe table of the OP's build. */
  probes(): Promise<ProbeTable> {
    return this.call('probes');
  }
}
