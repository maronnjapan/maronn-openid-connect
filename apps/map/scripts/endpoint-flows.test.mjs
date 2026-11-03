import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildFunctionFlow, tokenize } from '../../../packages/cli/src/extract/function-flow.ts';
import { removeOwnerBlocks } from '../../../packages/cli/src/extract/source.ts';
import { readRouteBlocks } from '../../../packages/cli/src/extract/blocks.ts';
import { buildOpFlow } from '../../../packages/cli/src/flow/build.ts';
import { FEATURE_CONFIG_KEYS } from '../../../packages/cli/src/registry.ts';
import { endpointFlow } from './endpoint-flows.mjs';

const reader = { buildFunctionFlow, tokenize, removeOwnerBlocks, readRouteBlocks };
const features = Object.fromEntries(FEATURE_CONFIG_KEYS.map((key) => [key, true]));
const endpoints = buildOpFlow({ features }).endpoints;
const implementation = (id, on = true) => {
  const source = readFileSync(new URL(`../../hono/src/oidc-provider/endpoints/${id}/pipeline.ts`, import.meta.url), 'utf8');
  const endpoint = endpoints.find((endpoint) => endpoint.id === id);
  return endpointFlow(source, { ...endpoint, steps: endpoint.steps.filter((step) => on || step.feature === undefined) }, reader);
};

describe('endpoint implementation flows', () => {
  it('ends a rejected authorization request at its early return, before resolving the client', () => {
    const flow = implementation('authorize');
    const check = flow.nodes.find((node) => node.label === "'kind' in parsed");
    const rejected = flow.edges.find((edge) => edge.from === check.id && edge.label === 'true');
    expect(flow.nodes.find((node) => node.id === rejected.to)?.label).toBe('return parsed');
    expect(flow.edges.filter((edge) => edge.from === rejected.to)).toEqual([]);
    const accepted = flow.edges.find((edge) => edge.from === check.id && edge.label === 'false');
    expect(flow.nodes.find((node) => node.id === accepted.to)?.step).toBe('resolve-pushed-request');
  });

  it('keeps prompt=none and SSO responses separate from the login continuation', () => {
    const flow = implementation('authorize');
    const check = flow.nodes.find((node) => node.label === 'silent !== undefined');
    const yes = flow.edges.find((edge) => edge.from === check.id && edge.label === 'true');
    expect(flow.nodes.find((node) => node.id === yes.to)?.label).toBe("'kind' in silent");
    const no = flow.edges.find((edge) => edge.from === check.id && edge.label === 'false');
    expect(flow.nodes.find((node) => node.id === no.to)?.step).toBe('reuse-session');
    expect(flow.nodes.filter((node) => node.step === 'issue-authorization-code')).toHaveLength(2);
  });

  it('removes the feature dispatch and its early return together when the feature is off', () => {
    const all = implementation('token');
    expect(all.nodes.some((node) => node.label === 'return idJagIssuance')).toBe(true);
    const base = implementation('token', false);
    expect(base.nodes.some((node) => node.label.includes('idJagIssuance'))).toBe(false);
    expect(base.nodes.some((node) => node.step === 'authenticate-client')).toBe(true);
  });

  it('keeps GET preparation and POST submission as separate entries even when they share a step', () => {
    const flow = implementation('login');
    expect(flow.nodes.filter((node) => node.kind === 'start').map((node) => node.label)).toEqual(['prepareLogin()', 'submitLogin()']);
    expect(flow.nodes.filter((node) => node.step === 'load-transaction')).toHaveLength(2);
    expect(new Set(flow.nodes.map((node) => node.id)).size).toBe(flow.nodes.length);
  });

  it('reads early returns in a Next.js inline block without running the following step', () => {
    const source = `export async function POST(request: Request): Promise<Response> {
      // [parse-request] Parse
      const parsed = await parse(request);
      if (!parsed.ok) return badRequest();
      // [respond] Respond
      return json(parsed);
    }`;
    const flow = endpointFlow(source, { methods: ['POST'], steps: [{ id: 'parse-request' }, { id: 'respond' }] }, reader, 'nextjs');
    const check = flow.nodes.find((node) => node.kind === 'condition');
    const failed = flow.edges.find((edge) => edge.from === check.id && edge.label === 'true');
    expect(flow.nodes.find((node) => node.id === failed.to)?.kind).toBe('return');
    expect(flow.edges.some((edge) => edge.from === failed.to)).toBe(false);
    expect(flow.nodes.some((node) => node.step === 'respond')).toBe(true);
  });

  it('keeps a constructor at the start of an inline step before its rejection branch', () => {
    const source = `export function GET(request: Request) {
      // [parse-request] Parse
      const url = new URL(request.url);
      if (!url.search) return badRequest();
      // [respond] Respond
      return json(url);
    }`;
    const flow = endpointFlow(source, { methods: ['GET'], steps: [{ id: 'parse-request' }, { id: 'respond' }] }, reader, 'nextjs');
    const start = flow.nodes.find((node) => node.kind === 'start');
    const first = flow.edges.find((edge) => edge.from === start.id);
    expect(flow.nodes.find((node) => node.id === first.to)?.step).toBe('parse-request');
  });
});
