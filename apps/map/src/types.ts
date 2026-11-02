/**
 * The shape of public/data/map.json: what `maronn-oidc explain --format json`
 * prints (packages/cli/src/explain/map.ts and flow/types.ts), with the flows
 * of every framework side by side and the function cards merged.
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
  version: 2;
  frameworks: string[];
  commands: MapCommand[];
  features: MapFeature[];
  flows: Record<string, OpFlow>;
  functions: Record<string, FunctionCard>;
}
