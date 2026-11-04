/**
 * The data the OIDC Provider Map reads: what the analysis writes and apps/map
 * shows. This module has no code and imports nothing, so the page can import
 * its types (`@maronn-openid-connect/map-analysis/model`).
 *
 * Two layers:
 *
 * - data/map.json (MapData): the endpoints, the cards of the functions, the
 *   members of the interfaces, the features and, in the map of a pull
 *   request, its changes. No tree.
 * - data/functions/<hash>.json (FrameFile): one frame each, a function or an
 *   endpoint body, with its flow tree; for a changed one, its tree before the
 *   change and the diff of the two. The page reads one when it opens the
 *   frame.
 */

// ---------------------------------------------------------------------------
// The flow of the generated provider (packages/cli: flow/types.ts, explain/map.ts)

export type StepKind = 'parse' | 'resolve' | 'validate' | 'decide' | 'dispatch' | 'issue' | 'persist' | 'transform' | 'respond';

export type FunctionKind = StepKind | 'other';

export interface FlowEdge {
  from: string;
  to: string;
  label?: string;
  kind: 'flow' | 'branch' | 'error';
}

export interface FlowStep {
  id: string;
  label: string;
  kind: StepKind;
  spec?: string;
  function: string;
  /** The card of the step's function; absent for Next.js, whose step is a block of a Route Handler. */
  functionId?: string;
  calls: string[];
  dynamicCalls?: string[];
  consumes: string[];
  produces: string[];
  /** The OidcFeatureConfig key of the feature that adds the step (refreshToken); absent for every provider. */
  feature?: string;
  removable: boolean;
  module?: string;
}

export interface FlowEndpoint {
  id: string;
  label: string;
  /** What the endpoint does (the JSDoc of its endpoint.ts). */
  summary?: string;
  path: string;
  methods: string[];
  layer: 'api' | 'browser' | 'metadata';
  group: { id: string; label: string };
  spec?: string;
  feature?: string;
  rearrangeable: boolean;
  /** The file of the endpoint under the root of its framework (endpoints/token/pipeline.ts, token/route.ts). */
  module?: string;
  /** The source file implementing the endpoint, a key of MapData.sources. */
  source?: string;
  steps: FlowStep[];
  edges: FlowEdge[];
  /** The frame the trace of the endpoint starts from: an endpoint body (`endpoint:token`) or a function. */
  root: string;
}

export interface OpFlow {
  version: 2;
  features: Record<string, boolean>;
  scopes: string[];
  db: string | null;
  endpoints: FlowEndpoint[];
  edges: FlowEdge[];
}

export interface MapFeature {
  id: string;
  tier: 'stable' | 'experimental' | 'extension';
  summary: string;
  enabled: boolean;
  flag: string;
  endpoints: string[];
  packages: string[];
}

export interface MapCommand {
  name: string;
  usage: string;
  summary: string;
}

// ---------------------------------------------------------------------------
// Flow trees

/**
 * call: a call of a function of the catalog, of a member of an interface of
 * the roots, or a call the types do not say the target of (untraceable);
 * action: a statement that calls none of those; if, switch, loop (a loop
 * statement, or a callback a call runs, `items.map((x) => f(x))`), try and
 * cond-expr (`?:`, `??`, `||`, `&&` and the logical assignments, with a call
 * in an arm) branch; return and throw end the frame; end is the end of the
 * body reached without a return; block is a step: the statements a marker
 * (`// [step-id] ...`) opens.
 */
export type NodeKind = 'call' | 'action' | 'if' | 'switch' | 'loop' | 'try' | 'cond-expr' | 'return' | 'throw' | 'block' | 'end';

/** What a call node calls. */
export type CallTarget =
  | { kind: 'function'; id: string }
  | { kind: 'member'; id: string }
  /**
   * A call whose target the types do not tell: a value read by a string key
   * (`c.get('store')`) of no known type. `method` is the name it calls
   * (`recordGrant` of `c.get('consentResolver')?.recordGrant(…)`), when it
   * calls a method.
   */
  | { kind: 'untraceable'; why: string; method?: string };

/** A step a node is: a block opened by a marker, or a call of the step's function. */
export interface StepMark {
  id: string;
  label: string;
  /** The feature the marker names (`refresh-token`). */
  feature?: string;
  spec?: string;
}

/** One side of a decision, with the nodes that run on it. */
export interface Branch {
  /** true / false, nullish / defined, c0 c1 ... / default, body / skip, try / catch / finally. */
  key: string;
  /** The side in words: 成立, 不成立, null または undefined, 値あり, case 'a', 例外が起きたとき, ... */
  label: string;
  nodes: TreeNode[];
  /** Where the side goes, in words: the step its first call is (`authorization_code グラントを検証する へ`). */
  toward?: string;
  /** finally: runs whichever side was taken; not a side to choose. */
  always?: boolean;
  /** A case that runs on into the next one. */
  fallsThrough?: boolean;
}

/**
 * One node of a flow tree. Its id is its position under its parent
 * (`s3` the fourth statement of the body, `s3t0` the first of its true side,
 * `s3i0` the first call evaluated before it, `s5c1s0`, `s2h0`, ...), so it
 * is the same in every build of the same code.
 */
export interface TreeNode {
  id: string;
  kind: NodeKind;
  /** The first and the last line (1-based, inclusive) of the file it takes, its comments and blank lines above it included. */
  lines: [number, number];
  /** The code, on one line and shortened: `parseTokenRequest(c)`, `if (!client)`, `return respondToken(…)`. */
  code: string;
  /** What it does in words, when there is something to say beyond the code. */
  text?: string;
  /** Where the words come from: the comment above it, the JSDoc of what it calls, or the code itself. */
  from?: 'comment' | 'doc' | 'code';
  target?: CallTarget;
  /** The calls (and the branching expressions) evaluated before the node itself: arguments, a condition, a header. */
  pre?: TreeNode[];
  /** The sides of a decision; for a loop body and skip, for a try try / catch / finally. */
  branches?: Branch[];
  /** A decision: the code a choice of it is named by (`exchanged`, `refreshTokenRequest`, `kind`). */
  subject?: string;
  /**
   * if: guard, a side that ends at once (`if (!x) throw ...`); optional, both
   * sides meet at once and the taken side calls nothing (`if (x) a.b = x`);
   * fork, any other.
   */
  form?: 'guard' | 'optional' | 'fork';
  /** cond-expr: the operator (`??`, `||`, `&&`, `?:`, `??=`, `||=`, `&&=`). */
  operator?: string;
  step?: StepMark;
  /** The feature a block belongs to, as its marker names it (`refresh-token`). */
  feature?: string;
  /**
   * A decision that reads a value a block of a feature produces: with the
   * feature off the block is gone, the value is undefined and only `side`
   * remains.
   */
  absent?: { feature: string; side: string };
  /** return / throw inside a callback: it ends the callback, not the frame. */
  local?: boolean;
  /** throw: the error, `TokenError(invalid_client)`. */
  error?: string;
  /** throw: it throws again what its catch caught. */
  rethrow?: boolean;
}

/** A frame: the tree of a function or of an endpoint body. */
export interface FlowTree {
  /** A function id (`core:client-auth.ts#verifyClientSecret`) or an endpoint body (`endpoint:token`). */
  id: string;
  /** verifyClientSecret, or `POST /token`. */
  name: string;
  /** The declaration as code: `verifyClientSecret(client, secret)`. */
  signature: string;
  /** The source of the file (a key of MapData.sources), `core:client-auth.ts`. */
  file: string;
  /** The lines of the whole frame, its JSDoc included. */
  lines: [number, number];
  /** The lines of the declaration up to the brace that opens the body: a change there is a change of the start. */
  head: [number, number];
  nodes: TreeNode[];
  /**
   * The members of interfaces the frame implements in an object literal it
   * returns (a store, a resolver): the lines of each implementation, and what
   * it calls (functions of the catalog and members, by id, the functions the
   * frame defines itself followed into).
   */
  implements?: Array<{ member: string; lines: [number, number]; calls?: string[] }>;
  /** Functions and members called inside definitions the frame makes (nested functions, methods): they do not run when it runs. */
  deferred?: string[];
  /** A tree made from the endpoint's handlers, with no lines of its own. */
  synthetic?: boolean;
}

/**
 * A choice of the sides of the decisions, by key. A key is `<frame>.<node>`:
 * the frame is the chain of call nodes from the root frame that opened it,
 * joined with dots, and is left out (with its dot) for the root frame.
 *
 * On a call node, the side `fails` says that the call throws there: the call
 * runs, the rest of its list does not, and the failure goes up to the
 * innermost `try` with a `catch` around it in that frame (or ends the frame).
 */
export type Decisions = Record<string, string>;

/** A choice the page offers ready-made (よく使う選択). */
export interface Selection {
  /** exit: how the frame ends; step: the way into a step; change: the way to a change; failure: a failure that ends it. */
  kind: 'exit' | 'step' | 'change' | 'failure';
  /** The labels that tell it apart (`exchanged: 成立`), or the step's label. */
  name: string;
  /** Where it leads, in words (`→ return respondToken(…)`). */
  note?: string;
  decisions: Decisions;
  /** The frames to open, by key. For a failure, each of their calls is decided `fails` (Decisions). */
  frames?: string[];
  /** The node it leads to, `<frame>.<node>` as a decision key. */
  target: string;
  /** For a failure: what fails, and the function that throws it (its id and name). */
  failure?: { error: string; from: string; name: string };
}

export interface FrameFile {
  version: 4;
  tree: FlowTree;
  selections: Selection[];
  change?: FrameChange;
}

// ---------------------------------------------------------------------------
// The index

/** A function of the catalog (packages/cli extract/functions.ts), with what the analysis found in its tree. */
export interface FunctionEntry {
  id: string;
  name: string;
  package: string;
  module: string;
  line: number;
  exported: boolean;
  kind: FunctionKind;
  summary: string;
  description?: string;
  spec?: string[];
  throws?: string[];
  /** The functions its tree calls, by id, resolved by the types, in the order of their first call. */
  calls: string[];
  /** The functions whose tree calls it. */
  calledBy: string[];
  /** The members of interfaces it calls. */
  members?: string[];
  /** The call nodes of its tree: [node id, function id or member id]. */
  sites: Array<[string, string]>;
  /** How many calls of its tree the types do not resolve (untraceable). */
  untraceable?: number;
  /** The failures that leave it (try/catch considered), with the function that throws each. */
  failures?: Failure[];
  /** The url of its FrameFile. */
  frame: string;
  /** The source file and its inclusive lines, the JSDoc and the overloads included. */
  source?: { file: string; start: number; end: number };
}

/** An endpoint body that is not a function of the catalog: the handler of a Hono pipeline (`tokenApp.post('/', async (c) => { ... })`). */
export interface BodyEntry {
  id: string;
  /** The endpoint, by id. */
  endpoint: string;
  /** `POST /token`. */
  name: string;
  package: string;
  module: string;
  line: number;
  summary: string;
  calls: string[];
  members?: string[];
  sites: Array<[string, string]>;
  untraceable?: number;
  failures?: Failure[];
  frame: string;
  synthetic?: boolean;
  source?: { file: string; start: number; end: number };
}

/** A failure that leaves a frame. */
export interface Failure {
  /** `TokenError(invalid_client)`, `Error`. */
  error: string;
  /** The function or body whose throw it is. */
  from: string;
}

/** A member of an interface or a type literal of the roots. */
export interface MemberDoc {
  /** `<root>:<module>#<Type>.<member>`. */
  id: string;
  type: string;
  member: string;
  summary: string;
  package: string;
  module: string;
  line: number;
  /** The functions whose object literals implement it. */
  implementedBy?: string[];
  /**
   * What its implementations call, across every implementation: functions of
   * the catalog and other interface members (a resolver's method that reads a
   * store calls the store's member). A change below one of them reaches every
   * call of this member.
   */
  calls?: string[];
}

/** A source file with Shiki tokens and the colors of its light and dark themes. */
export interface SourceDocument {
  code: string;
  foreground: string;
  background: string;
  tokens: Array<Array<{ content: string; color: string }>>;
}

export interface MapData {
  version: 4;
  frameworks: string[];
  commands: MapCommand[];
  features: MapFeature[];
  flows: Record<string, OpFlow>;
  functions: Record<string, FunctionEntry>;
  bodies: Record<string, BodyEntry>;
  members: Record<string, MemberDoc>;
  /** Source files fetched only when the code drawer opens; shared across functions and frameworks. */
  sources: Record<string, { path: string; url: string }>;
  /** The changes of the pull request, in the map of a pull request (built with MAP_BASE). */
  changes?: MapChanges;
}

// ---------------------------------------------------------------------------
// Changes

/**
 * How the pull request changed a frame: added, modified (its code), moved
 * (to another file, its code the same), docs (its JSDoc only), removed, or
 * noted (its code is the same, a change note explains it).
 */
export type ChangeKind = 'added' | 'modified' | 'moved' | 'docs' | 'removed' | 'noted';

/** A part of a unified diff: its lines (` `, `-` or `+`, then the text) from a line of the base and of the head. */
export interface DiffHunk {
  base: number;
  head: number;
  lines: string[];
  /** The tokens of each line, without its marker, from its revision. */
  tokens?: SourceDocument['tokens'];
}

/** A change inside an expression of a node: `<` changed to `<=`, an argument added. */
export interface ExprChange {
  /** In words: `\`<\` を \`<=\` に変えた`. */
  text: string;
  before?: string;
  after?: string;
}

/** A node of the tree before the change that the tree after has no match for. */
export interface RemovedNode {
  /** The node of the tree after it stood behind (absent: first of its list). */
  after?: string;
  /** The node of the tree after whose list it was in ('' for the body). */
  parent: string;
  /** The branch of the parent, for a decision. */
  branch?: string;
  node: TreeNode;
}

export interface FrameChange {
  kind: ChangeKind;
  /** The tree before the change (for a modified, moved or removed frame). */
  before?: FlowTree;
  /** The nodes of the tree after: added, or modified (matched, with other code). '' is the start (the declaration). */
  marks: Record<string, 'added' | 'modified'>;
  removed: RemovedNode[];
  /** The changes inside the expressions of the modified nodes. */
  exprs: Record<string, ExprChange[]>;
  /**
   * The hunks by node: each run of changed lines, with the lines around it
   * that its node holds, on the smallest node whose lines hold the run (a
   * marked one first); '' holds the runs in the JSDoc and the declaration.
   */
  hunks: Record<string, DiffHunk[]>;
  /** The diff in words, one phrase a change. */
  summary: string[];
}

/** What a change note says about a frame: the text of the section that names it. */
export interface ChangeNoteText {
  file: string;
  /** The heading of the section. */
  heading: string;
  text: string;
}

/** A change note of the pull request: what its text before the first heading says the pull request does. */
export interface ChangeNote {
  file: string;
  title?: string;
  summary: string;
}

/** A way from an endpoint to a change. */
export interface Reach {
  /** The source the endpoint is generated from: hono (Hono, Express and Fastify) or nextjs. */
  source: string;
  /** The frameworks that have the endpoint from that source. */
  frameworks: string[];
  endpoint: string;
  /** The step the way goes through. */
  step?: string;
  /** The frames to open from the root of the endpoint, by key. */
  frames: string[];
  decisions: Decisions;
  /** The frames between the root and the change, by id. */
  via: string[];
  /** The features the way needs on (marker ids, `refresh-token`). */
  features: string[];
  /** The changed node (or the call into the changed frame), as a decision key. */
  target: string;
  /** The change the way leads to, in words (`条件 \`a < b\``), when the frame has changes at more than one place. */
  label?: string;
  /**
   * The members of interfaces the way goes through below its last frame,
   * outermost first: the trace stops at the call of the first (an
   * implementation has no frame to open), the implementations of each call
   * the next, and the last calls the change or is the member whose
   * implementation changed.
   */
  through?: string[];
  /**
   * For a change that makes a new failure leave its frame: the frame on the
   * way whose `try` catches it (its id, name and `try` node, and the first
   * call of its catch, `respondTokenError(…)`).
   */
  caught?: { frame: string; name: string; node: string; call?: string };
  /** For a change that makes a new failure leave its frame: nothing on the way catches it, so it leaves the endpoint. */
  escapes?: true;
}

/** A frame the pull request changed, or one its change notes explain. */
export interface FrameChangeEntry {
  /** The frame's id; for a removed one, the id it had in the base. */
  id: string;
  name: string;
  package: string;
  module: string;
  line: number;
  kind: ChangeKind;
  /** An endpoint body, not a function of the catalog. */
  body?: boolean;
  /** The module it was in, when it moved. */
  from?: string;
  /** The diff in words. */
  summary: string[];
  /** The changes by what they are: `condition`, `call`, `return`, `throw`, `action`, ... each `+n` added, `-n` removed, `~n` modified. */
  counts: Record<string, number>;
  /** The lines of the head it adds or rewrites. */
  changedLines?: number[];
  notes?: ChangeNoteText[];
  /** Where the change takes effect: the ways from the endpoints. */
  reach: Reach[];
  /** The members of interfaces whose implementation it changed (every call of them is reached). */
  members?: string[];
  /**
   * The counts (see counts) of the changes inside the implementation of each
   * member of `members`: what a call of that member leads to, where `counts`
   * holds every change of the frame.
   */
  memberCounts?: Record<string, Record<string, number>>;
  /** The failures that leave it now and did not before, and the other way. */
  failuresAdded?: string[];
  failuresRemoved?: string[];
  /** Calls in it whose target the types do not tell. */
  untraceable?: number;
  /**
   * Calls whose target the types do not tell, outside the frames the change
   * is known to reach, that call a method of the name of a member the change
   * reaches through (`c.get('consentResolver')?.recordGrant(…)` for a change
   * of the implementation of `recordGrant`): the change may reach the
   * endpoints through them too, which the reach does not hold.
   */
  untraceableCallers?: Array<{ frame: string; node: string; why: string }>;
  /** The first line of what the notes say; absent without a note. */
  noteLine?: string;
  /** A note with text names it. */
  documented: boolean;
  /**
   * A change the map requires a note for: its code changed (not only its
   * comments or its layout, which leave the tree the same) and it reaches an
   * endpoint, or it is an endpoint body.
   */
  required: boolean;
}

/** The changes of the pull request the map is built for: those of the working tree since it forked from the base. */
export interface MapChanges {
  base: { ref: string; commit: string };
  head: { commit: string; dirty: boolean };
  pullRequest?: { number: number; title?: string; url?: string };
  notes: ChangeNote[];
  frames: FrameChangeEntry[];
  /** The sections of the notes whose heading names no frame: text about the whole pull request (背景, for one). */
  unmatched: Array<{ file: string; heading: string; text: string }>;
  /** The headings that name a function the catalog does not have. */
  unknown: Array<{ file: string; reference: string }>;
  /** The headings that name more than one changed frame by a bare name: narrow them with the root (`core:verifyClientSecret`). */
  ambiguous: Array<{ file: string; reference: string; matches: string[] }>;
  /** The changed frames that require a note and have none (the check of the map fails on them). */
  undocumented: string[];
  /** Changed lines of the files of the catalog outside every frame (imports, types, constants). */
  outside: Array<{ file: string; lines: number[] }>;
  /** The changed files that hold no frame: tests, documents, the CLI, the map itself. */
  otherFiles: number;
}
