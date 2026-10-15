import { describe, it, expect } from 'vitest';
import { DEFAULT_FEATURES, type OidcFeatureConfig } from '../features.js';
import { buildOpFlow } from '../flow/catalog.js';
import { resolveFlowSelection } from '../flow/flow-file.js';
import { annotateFlowModules } from '../flow/modules.js';
import { generate } from '../generator.js';

const ALL_FEATURES: OidcFeatureConfig = {
  pkce: true,
  refreshToken: true,
  introspection: true,
  revocation: true,
  requestObject: true,
  par: true,
  tokenExchange: true,
  jarm: true,
  deviceAuthorizationGrant: true,
  idJag: true,
  ciba: true,
  jwtIntrospectionResponse: true,
  rpInitiatedLogout: true,
  dynamicClientRegistration: true,
  googleLogin: true,
};

const MINIMAL_FEATURES: OidcFeatureConfig = {
  ...DEFAULT_FEATURES,
  pkce: false,
  refreshToken: false,
  introspection: false,
  revocation: false,
  requestObject: false,
};

/** The frameworks whose generated pipelines follow a --flow document's steps. */
const STEP_FRAMEWORKS = ['hono', 'express', 'fastify'];

const CONFIGURATIONS: Array<[string, OidcFeatureConfig, string[]]> = [
  ['the default features', DEFAULT_FEATURES, []],
  ['every feature and a custom scope', ALL_FEATURES, ['read']],
  ['the minimal features', MINIMAL_FEATURES, []],
];

const CASES = STEP_FRAMEWORKS.flatMap((framework) =>
  CONFIGURATIONS.map(([label, features, scopes]) => ({ framework, label, features, scopes })),
);

/** The generated path of every rearrangeable endpoint of a configuration. */
function rearrangeableModules(framework: string, features: OidcFeatureConfig, scopes: string[]): string[] {
  const flow = annotateFlowModules(buildOpFlow({ features, scopes }), framework);
  return flow.endpoints.filter((e) => e.rearrangeable).map((e) => e.module ?? e.id);
}

describe('generate', () => {
  describe('steps', () => {
    it.each(CASES)(
      'should generate every rearrangeable endpoint of $framework with $label when the document keeps every step',
      ({ framework, features, scopes }) => {
        const flow = buildOpFlow({ features, scopes });
        const selection = resolveFlowSelection(flow);
        const steps = Object.fromEntries(
          flow.endpoints.filter((e) => e.rearrangeable).map((e) => [e.id, e.steps.map((s) => s.id)]),
        );
        const { files } = generate({ framework, outputDir: 'out', features, scopes, steps });
        const paths = files.map((f) => f.path);
        const modules = rearrangeableModules(framework, features, scopes);
        expect(selection.steps).toEqual({});
        expect(paths.filter((p) => modules.includes(p))).toHaveLength(modules.length);
      },
    );

    it.each(CASES)(
      'should generate every rearrangeable endpoint of $framework with $label when every removable step is left out',
      ({ framework, features, scopes }) => {
        const flow = buildOpFlow({ features, scopes });
        const document = {
          ...flow,
          endpoints: flow.endpoints.map((e) => ({ ...e, steps: e.steps.filter((s) => !s.removable) })),
        };
        const selection = resolveFlowSelection(document);
        const { files } = generate({ framework, outputDir: 'out', features, scopes, steps: selection.steps });
        const paths = files.map((f) => f.path);
        const modules = rearrangeableModules(framework, features, scopes);
        expect(Object.keys(selection.steps).length).toBeGreaterThan(0);
        expect(paths.filter((p) => modules.includes(p))).toHaveLength(modules.length);
      },
    );

    it.each(STEP_FRAMEWORKS)(
      'should generate the token endpoint of %s with the subject resolved after the refresh token decision',
      (framework) => {
        const flow = buildOpFlow({ features: DEFAULT_FEATURES });
        const token = flow.endpoints.find((e) => e.id === 'token');
        const order = (token?.steps ?? []).map((s) => s.id);
        const subject = order.indexOf('resolve-subject');
        const decision = order.indexOf('decide-refresh-token-issuance');
        const reordered = [...order];
        reordered[subject] = 'decide-refresh-token-issuance';
        reordered[decision] = 'resolve-subject';
        const document = {
          ...flow,
          endpoints: flow.endpoints.map((e) =>
            e.id === 'token' ? { ...e, steps: reordered.map((id) => ({ id })) } : e,
          ),
        };
        const selection = resolveFlowSelection(document);
        const { files } = generate({ framework, outputDir: 'out', features: DEFAULT_FEATURES, steps: selection.steps });
        expect(selection.steps).toEqual({ token: reordered });
        expect(files.map((f) => f.path)).toContain('routes/token.ts');
      },
    );

    it('should refuse a rearranged step order for the Next.js output', () => {
      expect(() =>
        generate({
          framework: 'nextjs',
          outputDir: 'out',
          features: DEFAULT_FEATURES,
          steps: { token: ['parse-request'] },
        }),
      ).toThrow(
        'The Next.js output does not follow a rearranged step order yet (endpoint "token"). ' +
          'Remove the steps changes from the flow document, or generate for hono, express or fastify',
      );
    });
  });
});
