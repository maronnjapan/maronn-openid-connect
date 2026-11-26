/**
 * The Worker of the map: the map's pages (the static assets of dist/) and,
 * at the same origin, the live OP (packages/live-op), the server app of
 * apps/hono with every feature, which the pages send their requests to.
 *
 * A request for a path of the OP or of its control API (isLivePath: the
 * paths wrangler.jsonc's `assets.run_worker_first` sends here) goes to the
 * Durable Object of its workspace (workspaceIdOf: the header or the cookie
 * the page sets, else the public workspace), one per workspace and origin;
 * any other is answered by the assets (the page, or index.html for a path
 * of the page).
 *
 * The Durable Object (LiveOpWorkspace, SQLite-backed, so it runs on the
 * Workers Free plan) holds the workspace: the OP opened on what its storage
 * keeps (storage.ts) with the origin of its requests as the issuer, so the
 * OP's pages and redirects point back where the browser is. A workspace
 * that receives no request for IDLE_LIFETIME (7 days) is deleted by its
 * alarm.
 *
 * The module exports only what the runtime takes from a Worker's entry: the
 * handler and the Durable Object class.
 */
import { DurableObject } from 'cloudflare:workers';
import { answerLive, isLivePath, LiveWorkspace, workspaceIdOf } from '@maronn-openid-connect/live-op';
import { DurableStorage } from './storage.js';

/** The bindings of the Worker (wrangler.jsonc). */
export interface Env {
  ASSETS: Fetcher;
  LIVE_OP: DurableObjectNamespace;
}

/** How long a workspace is kept after its last request, in milliseconds (7 days). */
const IDLE_LIFETIME = 7 * 24 * 60 * 60 * 1000;

/** How far the alarm may be behind IDLE_LIFETIME after the last request before a request moves it (1 hour), so most requests write no alarm. */
const ALARM_SLACK = 60 * 60 * 1000;

/** The name of the Durable Object of a request: its origin and its workspace, so a workspace opened at one origin is never opened at another. */
function workspaceNameOf(request: Request): string {
  return `${new URL(request.url).origin} ${workspaceIdOf(request)}`;
}

/** A JSON error of the Worker itself (the OP could not be opened). */
function failure(error: unknown): Response {
  const description = error instanceof Error ? error.message : String(error);
  return Response.json({ error: 'server_error', error_description: description }, { status: 500, headers: { 'cache-control': 'no-store' } });
}

/** The Durable Object of a workspace of the live OP (see the module comment). */
export class LiveOpWorkspace extends DurableObject<Env> {
  /** The workspace, opened by the first request since the Durable Object was started, with the name it was opened for. */
  private opened: { name: string; workspace: Promise<LiveWorkspace> } | undefined;
  /** When the alarm is set to go off, once read or set. */
  private alarmAt: number | undefined;
  /** When the last request came, since the Durable Object was started. */
  private lastRequestAt = 0;

  /** Answer a request for the OP or its control API on the workspace. */
  override async fetch(request: Request): Promise<Response> {
    try {
      this.lastRequestAt = Date.now();
      await this.keepAlive();
      return await answerLive(await this.workspaceOf(request), request);
    } catch (error) {
      return failure(error);
    }
  }

  /** Delete the workspace when it has received no request for IDLE_LIFETIME; move the alarm on when it has. */
  override async alarm(): Promise<void> {
    const due = this.lastRequestAt + IDLE_LIFETIME;
    if (due > Date.now()) {
      this.alarmAt = due;
      await this.ctx.storage.setAlarm(due);
      return;
    }
    this.opened = undefined;
    this.alarmAt = undefined;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** Set the alarm IDLE_LIFETIME after now, unless it is already within ALARM_SLACK of that. */
  private async keepAlive(): Promise<void> {
    const due = Date.now() + IDLE_LIFETIME;
    this.alarmAt ??= (await this.ctx.storage.getAlarm()) ?? 0;
    if (due - this.alarmAt < ALARM_SLACK) return;
    this.alarmAt = due;
    await this.ctx.storage.setAlarm(due);
  }

  /** The workspace of a request: opened on the storage at the request's origin the first time, the same one after. */
  private workspaceOf(request: Request): Promise<LiveWorkspace> {
    const name = workspaceNameOf(request);
    if (this.opened?.name !== name) {
      const workspace = LiveWorkspace.open(workspaceIdOf(request), new URL(request.url).origin, new DurableStorage(this.ctx.storage));
      const opened = { name, workspace };
      this.opened = opened;
      workspace.catch(() => {
        if (this.opened === opened) this.opened = undefined;
      });
    }
    return this.opened.workspace;
  }
}

/** The Worker's handler: the live paths to the workspace's Durable Object, every other to the assets. */
async function fetchOfWorker(request: Request, env: Env): Promise<Response> {
  if (!isLivePath(new URL(request.url).pathname)) return env.ASSETS.fetch(request);
  return env.LIVE_OP.get(env.LIVE_OP.idFromName(workspaceNameOf(request))).fetch(request);
}

export default { fetch: fetchOfWorker };
