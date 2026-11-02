/**
 * The shape of public/data/map.json: what `maronn-oidc explain --format json`
 * prints (packages/cli/src/explain/map.ts and flow/types.ts), with the flows
 * of every framework side by side, every function of the catalog with the
 * flow of its body (extract/function-flow.ts), and the members of the
 * interfaces the code calls through a resolver or a store.
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
  kind: 'start' | 'call' | 'dynamic' | 'return' | 'throw' | 'end';
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
  steps: FlowStep[];
  edges: FlowEdge[];
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
}
