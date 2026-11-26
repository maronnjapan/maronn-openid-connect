/**
 * The live OP (see api.ts): the bundle a host loads, dist/live-op.js. It
 * holds the server app of apps/hono counted by Istanbul, and makes the
 * counters note the order they go up in as soon as every module is loaded
 * (recorder.ts), before any request.
 */
import { installRecorder } from './recorder.js';

export * from './api.js';
export { oauthErrorOf, LiveWorkspace, MemoryStorage, requestOf, type Answered, type WorkspaceSnapshot, type WorkspaceStorage } from './workspace.js';
export { answerLive, isLivePath, OP_ROUTES, workspaceIdOf } from './relay.js';
export { probeTable } from './recorder.js';
export { RECIPES } from './scenarios/index.js';
export { prepareRecipe, type ScenarioContext, type ScenarioRecipe } from './scenario-runtime.js';
export { runGrant, sendStep } from './grant.js';
export { liveClients, LIVE_USERS, RP_CALLBACK } from './seed.js';

installRecorder();
