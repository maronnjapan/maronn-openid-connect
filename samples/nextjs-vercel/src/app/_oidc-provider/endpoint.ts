/**
 * What an endpoint.ts beside a route.ts says about its Route Handler: the
 * steps it runs, in order, as its marker lines name them
 * (`// [step-id] Label — Spec`, `// [step-id] (feature: <id>) Label — Spec`),
 * and the values each step reads and defines.
 *
 * `maronn-oidc generate` reads it when it removes the block of a disabled
 * feature: a value the block defined that a later step still reads is left as
 * `const <name> = undefined;`. The lint of .github/scripts checks that the
 * steps match the markers of the route.ts.
 */
export interface EndpointStep {
  /** The id of the marker line. */
  readonly id: string;
  /** The feature whose block it is; absent for a step of the provider. */
  readonly feature?: string;
  /** The values of the handler the step reads. */
  readonly consumes: readonly string[];
  /** The values the step defines (or assigns). */
  readonly produces: readonly string[];
}

export interface EndpointMeta {
  /** The path of the Route Handler. */
  readonly path: string;
  readonly steps: readonly EndpointStep[];
}

/**
 * ルートハンドラの説明を受け取り、そのまま返す。
 *
 * 説明には、ルートハンドラのパスと、実行するステップが含まれる。
 * 実行時には何もしない。
 * 引数が `EndpointMeta` の形であることは、TypeScript の型検査で確かめる。
 */
export function defineEndpoint<const E extends EndpointMeta>(endpoint: E): E {
  return endpoint;
}
