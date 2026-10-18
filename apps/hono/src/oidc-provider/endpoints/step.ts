/**
 * The description every step and every endpoint of the provider carries.
 *
 * A step is one function of an endpoint's pipeline, in a file of its own
 * (endpoints/<endpoint>/steps/<step-id>.ts, or features/<id>/.../steps/ for the
 * steps a feature adds). Its `meta` names it, says which values of the
 * pipeline it reads and defines, and whether `--flow` may leave it out.
 * `maronn-oidc graph` draws the provider from these descriptions, so a box of
 * the diagram is always one function of the code.
 *
 * The values a step reads and defines are the local names of the pipeline
 * (`params`, `client`, `validatedRequest`, ...). The request context `c` is
 * available to every step and is not listed.
 */

/**
 * The responsibility of a step: functions are split by what they do, so each
 * box does one kind of thing.
 */
export type StepKind =
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

export interface StepMeta {
  /** Unique within the endpoint (kebab-case); the id of the pipeline's marker line. */
  readonly id: string;
  /** The endpoint whose pipeline runs the step. */
  readonly endpoint: string;
  /** The feature that adds the step. Absent for the steps of every provider. */
  readonly feature?: string;
  readonly kind: StepKind;
  /** The name of the box. */
  readonly label: string;
  /** The specification section(s) the step implements. */
  readonly spec?: string;
  /** The exported function of the step. */
  readonly function: string;
  /** The core / experimental functions the step calls, in order. */
  readonly calls?: readonly string[];
  /** The pipeline values the step reads. */
  readonly consumes: readonly string[];
  /** The pipeline values the step defines. */
  readonly produces: readonly string[];
  /**
   * Whether `--flow` may leave the step out. A step that stays must not read
   * what a left-out step defines, unless that step has a fallback.
   */
  readonly removable: boolean;
  /**
   * When the step is left out, the values it defines are undefined, and the
   * steps that read them act as if it found nothing.
   */
  readonly fallback?: boolean;
  /** Steps it must stay after when `--flow` reorders the pipeline, beside its data. */
  readonly after?: readonly string[];
  /** Steps it must stay before. */
  readonly before?: readonly string[];
  /**
   * Steps that call this one. It is not a stage of the pipeline itself, and
   * stays while a caller stays.
   */
  readonly calledFrom?: readonly string[];
}

/** Describe a step. The function only checks the shape; it returns its argument. */
export function step<const M extends StepMeta>(meta: M): M {
  return meta;
}

/**
 * What a feature adds to a step of the provider without a block of its own:
 * a hook the step runs (a login method the describe-login-screen step renders,
 * for one). `maronn-oidc graph` adds the calls and the values to the box of
 * that step while the feature is generated.
 */
export interface StepContribution {
  readonly endpoint: string;
  /** The id of the step. */
  readonly step: string;
  readonly feature: string;
  readonly calls?: readonly string[];
  readonly consumes?: readonly string[];
}

/** Describe a contribution. The function only checks the shape; it returns its argument. */
export function contribute<const C extends StepContribution>(contribution: C): C {
  return contribution;
}

/** An arrow of the diagram: between two steps of an endpoint, or between two endpoints. */
export interface EdgeMeta {
  readonly from: string;
  readonly to: string;
  readonly label?: string;
  /** flow: the normal path; branch: one of several alternatives; error: the path of a failure. */
  readonly kind: 'flow' | 'branch' | 'error';
}

export interface EndpointMeta {
  /** Unique within the provider (kebab-case). */
  readonly id: string;
  readonly label: string;
  /** The HTTP path, as app.ts mounts it. */
  readonly path: string;
  readonly methods: readonly string[];
  /** api: called by a client; browser: the End-User's browser is sent here; metadata: read before any flow. */
  readonly layer: 'api' | 'browser' | 'metadata';
  /** The flow of the protocol the endpoint belongs to. */
  readonly group: { readonly id: string; readonly label: string };
  readonly spec?: string;
  /** The feature that serves the endpoint. Absent for the endpoints of every provider. */
  readonly feature?: string;
  /**
   * Whether `--flow` may remove or reorder the steps. false for the screens,
   * whose steps are fixed entry points.
   */
  readonly rearrangeable: boolean;
  /** Values the pipeline has before its first step (read from the context). */
  readonly initial?: readonly string[];
  /** The step every failing step ends in: the dashed arrows into it. */
  readonly errorStep?: string;
  /**
   * The arrows between the steps. 'chain' draws one arrow from each stage of
   * the pipeline to the next, in the order of pipeline.ts; listed arrows are
   * drawn beside it (or alone, without 'chain').
   */
  readonly edges: { readonly chain: boolean; readonly extra?: readonly EdgeMeta[] };
  /**
   * Arrows between endpoints: how a client or browser travels to and from
   * this one. An endpoint lists the arrows it takes part in that no endpoint
   * before it in the provider lists; an arrow to an endpoint the provider
   * does not have is not drawn.
   */
  readonly journeys?: readonly EdgeMeta[];
}

/** Describe an endpoint. The function only checks the shape; it returns its argument. */
export function defineEndpoint<const M extends EndpointMeta>(meta: M): M {
  return meta;
}
