/**
 * The shape of public/data/map.json: what `maronn-oidc explain --format json`
 * prints (packages/cli/src/explain/map.ts and flow/types.ts), with the flows
 * of every framework side by side, every function of the catalog with the
 * flow of its body (extract/function-flow.ts), the members of the
 * interfaces the code calls through a resolver or a store, and, in the map
 * of a pull request, its changes (scripts/changes.mjs).
 */
export type StepKind =
  | 'parse'
  | 'resolve'
  | 'validate'
  | 'decide'
  | 'dispatch'
  | 'issue'
  | 'persist'
  | 'transform'
  | 'respond';

export type FunctionKind = StepKind | 'other';

/** One box of the flow of a function. */
export interface FunctionFlowNode {
  id: string;
  kind: 'start' | 'condition' | 'call' | 'dynamic' | 'return' | 'throw' | 'end';
  /** An endpoint implementation's call of this step. */
  step?: string;
  label: string;
  /** For a call: the id of the card of the callee. */
  callee?: string;
  /** For a dynamic call: the member it reaches, `Type.member` (a key of MapData.members). */
  member?: string;
  /** The comment above the statement: what the author says the line does. */
  note?: string;
  line: number;
}

export interface FunctionFlowEdge {
  from: string;
  to: string;
  label?: string;
  kind: 'flow' | 'branch' | 'error';
}

export interface FunctionFlow {
  nodes: FunctionFlowNode[];
  edges: FunctionFlowEdge[];
}

export interface FunctionCard {
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
  calls: string[];
  calledBy: string[];
  flow?: FunctionFlow;
  /** The source file and inclusive lines, with the JSDoc and overloads. */
  source?: { file: string; start: number; end: number };
}

/** A member of an interface or a type literal, with what its JSDoc says. */
export interface MemberDoc {
  type: string;
  member: string;
  summary: string;
  package: string;
  module: string;
  line: number;
}

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
  functionId?: string;
  calls: string[];
  dynamicCalls?: string[];
  consumes: string[];
  produces: string[];
  /** The OidcFeatureConfig key of the feature that adds the step (refreshToken), absent for every provider. */
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
  module?: string;
  /** The source file implementing the endpoint, a key of MapData.sources. */
  source?: string;
  steps: FlowStep[];
  edges: FlowEdge[];
  /** Implementation flows for each enabled combination of step features. */
  controlFlows?: Record<string, FunctionFlow>;
  /** The implementation flow selected by the current feature configuration. */
  controlFlow?: FunctionFlow;
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

/**
 * How the pull request the map is built for changed a function: added,
 * modified (its code), moved (to another file, its code the same), docs (its
 * JSDoc only), removed, or noted (its code is the same, a change note
 * explains it).
 */
export type ChangeKind = 'added' | 'modified' | 'moved' | 'docs' | 'removed' | 'noted';

/**
 * A part of the diff of a function: the lines of a unified diff (` `, `-` or
 * `+`, then the text), from a line of the base (`base`) and of the head
 * (`head`).
 */
export interface DiffHunk {
  base: number;
  head: number;
  lines: string[];
}

/** What a change note says about a function: the text of the section that names it. */
export interface ChangeNoteText {
  /** The note, from the root of the repository (`apps/map/changes/….md`). */
  file: string;
  text: string;
}

/** A function the pull request changed, or that one of its change notes explains. */
export interface FunctionChange {
  /** The id of the card; for a removed function, the id it had in the base. */
  id: string;
  name: string;
  package: string;
  module: string;
  line: number;
  kind: ChangeKind;
  /** The module the function was in, when it moved (or changed in a renamed file). */
  from?: string;
  /** For a removed function: the first paragraph of its JSDoc in the base. */
  summary?: string;
  /** The lines of the head the pull request adds or rewrites in the function (its JSDoc included). */
  changedLines?: number[];
  hunks?: DiffHunk[];
  notes?: ChangeNoteText[];
}

/** A change note of the pull request: what its text before the first heading says the pull request does. */
export interface ChangeNote {
  file: string;
  title?: string;
  summary: string;
}

/**
 * The changes of the pull request the map is built for (apps/map/scripts/changes.mjs):
 * those of the working tree since it forked from the base.
 */
export interface MapChanges {
  /** The revision compared with, as given (origin/main), and the commit the working tree forked from it at. */
  base: { ref: string; commit: string };
  /** The commit the map was built at, and whether the working tree had uncommitted changes. */
  head: { commit: string; dirty: boolean };
  pullRequest?: { number: number; title?: string; url?: string };
  /** The change notes the pull request adds or edits. */
  notes: ChangeNote[];
  /** The changed functions, by id. */
  functions: FunctionChange[];
  /** The sections of the notes whose heading names no function: text about the whole pull request (背景, for one). */
  unmatched: Array<{ file: string; heading: string; text: string }>;
  /** The changed files that hold no function of the catalog: tests, documents, the CLI, the map itself. */
  otherFiles: number;
}

/** A source asset with Shiki tokens and colors from its bundled light/dark themes. */
export interface SourceDocument {
  code: string;
  foreground: string;
  background: string;
  tokens: Array<Array<{ content: string; color: string }>>;
}

export interface MapData {
  version: 3;
  frameworks: string[];
  commands: MapCommand[];
  features: MapFeature[];
  flows: Record<string, OpFlow>;
  functions: Record<string, FunctionCard>;
  /** The members the flows reach, by `Type.member`. */
  members: Record<string, MemberDoc>;
  /** The member each call a step names beside its source reaches (`consentResolver.recordConsent` → `ConsentResolver.recordConsent`). */
  memberOfCall: Record<string, string>;
  /**
   * The arrows of each endpoint for each combination of the features that add
   * steps to it: endpoint id → the feature keys that are on, sorted and joined
   * with commas → the arrows of that generation.
   */
  edgeSets: Record<string, Record<string, FlowEdge[]>>;
  /** Source files fetched only when the code drawer opens; shared across functions and frameworks. */
  sources?: Record<string, { path: string; url: string }>;
  /** The changes of the pull request, in the map of a pull request (built with MAP_BASE). */
  changes?: MapChanges;
}
