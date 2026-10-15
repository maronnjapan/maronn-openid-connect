/**
 * The generated OpenID Provider as boxes and arrows.
 *
 * An OpFlow describes what a `generate` run produces at the level a diagram
 * shows it: the endpoints (one box each), the steps inside every endpoint
 * (one box per generated function) and the arrows between them. It is the
 * single source of truth for three things that must never drift apart:
 *
 * - `maronn-oidc graph`, which renders it as Mermaid or JSON;
 * - the generated route modules, whose pipelines are assembled from the same
 *   step list so that every box of the diagram is one function in the code;
 * - `--flow <file>`, which reads a (possibly rearranged) OpFlow back and
 *   generates from it.
 *
 * The model is framework-neutral. Framework-specific details — which module a
 * step lives in — are added by the generators (see `annotateFlowModules`).
 */
import type { DbKind } from '../db.js';
import type { OidcFeatureConfig } from '../features.js';

/** Where a request to the endpoint comes from. */
export type FlowEndpointLayer =
  /** Back channel: the client (or a resource server) calls it directly. */
  | 'api'
  /** Front channel: the End-User's browser is sent here and sees a screen or a redirect. */
  | 'browser'
  /** Published OP metadata, read by clients before any flow. */
  | 'metadata';

/**
 * The responsibility of a step. Mirrors the rule of the repository that
 * functions are split by responsibility (validate / resolve / persist /
 * transform) so each box does one kind of thing.
 */
export type FlowStepKind =
  /** Read the HTTP request into typed values. */
  | 'parse'
  /** Look something up: a client, a token, a session, a key. */
  | 'resolve'
  /** Check a rule; fails with an OAuth / OIDC error. */
  | 'validate'
  /** Make a policy decision that later steps act on. */
  | 'decide'
  /** Answer a request that belongs to another grant or flow and stop. */
  | 'dispatch'
  /** Mint a token, a code, a record. */
  | 'issue'
  /** Write state to a store. */
  | 'persist'
  /** Turn values into another shape (a response body, a URL). */
  | 'transform'
  /** Turn the result into HTTP. */
  | 'respond';

/** One box inside an endpoint: exactly one function of the generated code. */
export interface FlowStep {
  /** Stable identifier, unique within the endpoint (kebab-case). */
  id: string;
  /** Human-readable name of the box. */
  label: string;
  kind: FlowStepKind;
  /** Specification section(s) the step implements, when there is one. */
  spec?: string;
  /** Name of the generated function (hono / express / fastify output). */
  function: string;
  /** Core or experimental functions the step calls, in order. */
  calls: string[];
  /** Pipeline values the step reads: the arrows that come in. */
  consumes: string[];
  /** Pipeline values the step defines: the arrows that go out. */
  produces: string[];
  /**
   * The feature that puts this step in the pipeline. Absent for steps that are
   * generated in every configuration.
   */
  feature?: keyof OidcFeatureConfig;
  /**
   * Whether `--flow` may leave the step out. A removed step's `produces` must
   * not be read by a step that stays (the loader checks this), unless the step
   * declares `otherwise`, the values the pipeline falls back to.
   */
  removable: boolean;
  /**
   * For a removable step whose `produces` later steps read: when the step is
   * left out, the pipeline defines those values with defaults (undefined), so
   * the readers keep compiling and act as if the step found nothing.
   */
  fallback?: boolean;
  /**
   * Steps this one must stay after when `--flow` reorders the pipeline, beyond
   * what the data flow already enforces (an ordering the specification requires).
   */
  after?: string[];
  /** Steps this one must stay before (for example, a grant dispatch before the grant_type check). */
  before?: string[];
  /**
   * Steps whose generated function calls this one. Such a step is not a stage
   * of the pipeline itself: it is kept while any caller is kept and cannot be
   * removed while a caller stays.
   */
  calledFrom?: string[];
  /** Generated module that holds the function; set by the framework generator. */
  module?: string;
}

export type FlowEdgeKind =
  /** The normal path from one box to the next. */
  | 'flow'
  /** One of several alternatives chosen by a value (a grant_type, a decision). */
  | 'branch'
  /** The path taken when a step fails. */
  | 'error';

/** An arrow between two boxes (steps within an endpoint, or endpoints). */
export interface FlowEdge {
  from: string;
  to: string;
  label?: string;
  kind: FlowEdgeKind;
}

/** A group of endpoints that belong to one flow of the protocol. */
export interface FlowGroup {
  id: string;
  label: string;
}

/** One top-level box: an endpoint of the generated OP. */
export interface FlowEndpoint {
  /** Stable identifier (kebab-case). */
  id: string;
  label: string;
  /** The HTTP path, as mounted by the generated app. */
  path: string;
  methods: string[];
  layer: FlowEndpointLayer;
  group: FlowGroup;
  spec?: string;
  /**
   * The feature that generates this endpoint. Absent for the Basic OP
   * endpoints, which every configuration has.
   */
  feature?: keyof OidcFeatureConfig;
  /**
   * Whether `--flow` may remove or reorder the steps of this endpoint. false
   * for endpoints whose logic is a fixed sequence of entry points (screens);
   * their steps are listed for the diagram and must be passed through unchanged.
   */
  rearrangeable: boolean;
  /** Generated module that holds the logic; set by the framework generator. */
  module?: string;
  /**
   * Values the pipeline has before its first step runs (read from the request
   * context, such as the issuer), so steps may consume them.
   */
  initial?: string[];
  steps: FlowStep[];
  /** Arrows between the steps. */
  edges: FlowEdge[];
}

/** The whole generated OP as a graph. */
export interface OpFlow {
  version: 1;
  features: OidcFeatureConfig;
  scopes: string[];
  db: DbKind | null;
  endpoints: FlowEndpoint[];
  /** Arrows between endpoints: how a client or browser travels through the OP. */
  edges: FlowEdge[];
}
