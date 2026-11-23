/**
 * The requests the map tries on its OP to find, for each way of an endpoint,
 * a request that takes it (packages/test-catalog samples.ts): the requests a
 * client sends to the endpoint, written with the premises, then each of them
 * changed in one place: a field left out, given a value the OP does not
 * hold, or sent twice; the client authenticated with a wrong secret, as a
 * client the OP does not know, the other way, as another client, both ways
 * at once, or not at all; the body sent without its content type. Which way
 * a request takes is found by running it, never assumed here: a way none of
 * them takes has no request. Plain data from the premises: it imports
 * nothing of the OP.
 */
import type { SandboxRequest } from './api.js';
import { PREMISES, type Premises } from './premises.js';

/** The endpoints the map tries requests at, by id. */
export const SAMPLED_ENDPOINTS: readonly string[] = ['token'];

/** How a request authenticates its client: in the Authorization header (Basic), in the body with its secret, by its id alone, or not at all. */
interface Credentials {
  id: string;
  secret: string;
  method: 'client_secret_basic' | 'client_secret_post' | 'none' | 'absent';
}

/** A request with a form body to an endpoint, before it is changed. */
interface FormTemplate {
  path: string;
  fields: Array<[string, string]>;
  client: Credentials;
}

/** The Authorization header of client_secret_basic (RFC 6749 §2.3.1). */
function basic(id: string, secret: string): string {
  return `Basic ${btoa(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`)}`;
}

/** A form request as a client sends it: its fields, with its credentials in the header or the body. */
function formRequest(path: string, fields: ReadonlyArray<[string, string]>, client: Credentials, headers: Array<[string, string]> = [['content-type', 'application/x-www-form-urlencoded']]): SandboxRequest {
  const sent = [...headers];
  const body = [...fields];
  if (client.method === 'client_secret_basic') sent.push(['authorization', basic(client.id, client.secret)]);
  if (client.method === 'client_secret_post') body.push(['client_id', client.id], ['client_secret', client.secret]);
  if (client.method === 'none') body.push(['client_id', client.id]);
  return { method: 'POST', path, headers: sent, body: new URLSearchParams(body).toString() };
}

/** The credentials of a client of the premises, the way it authenticates. */
function credentialsOf(clientId: string): Credentials {
  const client = PREMISES.clients.find((candidate) => candidate.clientId === clientId);
  if (client === undefined) throw new Error(`No client ${clientId} in the premises of the OP of the map`);
  return { id: client.clientId, secret: client.clientSecret ?? '', method: client.authMethod };
}

/** A request and the requests made of it by changing one place (see the module comment). */
function variants(template: FormTemplate): SandboxRequest[] {
  const { path, fields, client } = template;
  const requests = [formRequest(path, fields, client)];
  fields.forEach(([name, value], index) => {
    requests.push(formRequest(path, fields.filter((_, at) => at !== index), client));
    requests.push(formRequest(path, fields.map((field, at): [string, string] => (at === index ? [name, `${value}-unknown`] : field)), client));
    requests.push(formRequest(path, [...fields, [name, value]], client));
  });
  const other = PREMISES.clients.find((candidate) => candidate.clientId !== client.id && candidate.grantTypes.some((grant) => fields.some(([name, value]) => name === 'grant_type' && value === grant)));
  const otherWay: Credentials['method'] = client.method === 'client_secret_basic' ? 'client_secret_post' : 'client_secret_basic';
  for (const changed of [
    { ...client, method: 'absent' as const },
    { ...client, method: 'none' as const },
    { ...client, secret: `${client.secret}-wrong` },
    { ...client, id: 'unknown-client' },
    { ...client, method: otherWay },
    ...(other === undefined ? [] : [credentialsOf(other.clientId)]),
  ]) {
    requests.push(formRequest(path, fields, changed));
  }
  // Both ways at once, and a client_id in the body that is not the client of the header.
  requests.push(formRequest(path, [...fields, ['client_secret', client.secret]], { ...client, method: 'client_secret_basic' }));
  requests.push(formRequest(path, [...fields, ['client_id', other?.clientId ?? 'unknown-client']], { ...client, method: 'client_secret_basic' }));
  // A header that is not Basic credentials, and a body without its content type.
  requests.push({ ...formRequest(path, fields, { ...client, method: 'absent' }), headers: [['content-type', 'application/x-www-form-urlencoded'], ['authorization', 'Basic not-credentials']] });
  requests.push(formRequest(path, fields, client, []));
  return requests;
}

/** The fields of the authorization_code grant of a code of the premises: the code, its redirect_uri, and its PKCE verifier when it has one. */
function codeFieldsOf(code: Premises['codes'][number] | undefined): Array<[string, string]> {
  if (code === undefined) return [];
  return [['grant_type', 'authorization_code'], ['code', code.code], ['redirect_uri', code.redirectUri], ...(code.pkce === undefined ? [] : [['code_verifier', code.pkce.verifier] as [string, string]])];
}

/** The requests a client sends to the token endpoint, one a grant (and the scopes it asks for), with the premises. */
function tokenTemplates(): FormTemplate[] {
  const client1 = credentialsOf('client-1');
  const service = credentialsOf('service-1');
  const [code, ...otherCodes] = PREMISES.codes;
  const refresh = PREMISES.refreshTokens[0];
  const codeFields = codeFieldsOf(code);
  const refreshFields: Array<[string, string]> = refresh === undefined ? [] : [['grant_type', 'refresh_token'], ['refresh_token', refresh.token]];
  const templates: FormTemplate[] = [
    { path: '/token', fields: codeFields, client: client1 },
    // The other codes of the premises, and a verifier PKCE cannot be (shorter than 43 characters).
    ...otherCodes.map((other) => ({ path: '/token', fields: codeFieldsOf(other), client: credentialsOf(other.clientId) })),
    { path: '/token', fields: codeFields.map(([name, value]): [string, string] => [name, name === 'code_verifier' ? 'short' : value]), client: client1 },
    // A client asking for a grant it was not registered for.
    { path: '/token', fields: [['grant_type', 'client_credentials']], client: client1 },
    { path: '/token', fields: codeFields, client: service },
    { path: '/token', fields: refreshFields, client: client1 },
    { path: '/token', fields: [...refreshFields, ['scope', 'openid']], client: client1 },
    { path: '/token', fields: [...refreshFields, ['scope', 'openid admin']], client: client1 },
    { path: '/token', fields: [...refreshFields, ['scope', '']], client: client1 },
    { path: '/token', fields: [['grant_type', 'client_credentials'], ['scope', 'reports.read']], client: service },
    { path: '/token', fields: [['grant_type', 'client_credentials']], client: service },
    { path: '/token', fields: [['grant_type', 'client_credentials'], ['scope', 'openid']], client: service },
    { path: '/token', fields: [['grant_type', 'client_credentials'], ['scope', 'reports.delete']], client: service },
    { path: '/token', fields: [['grant_type', 'urn:ietf:params:oauth:grant-type:device_code'], ['device_code', 'device-code-1']], client: client1 },
    { path: '/token', fields: [['grant_type', 'urn:openid:params:grant-type:ciba'], ['auth_req_id', 'auth-req-1']], client: client1 },
    {
      path: '/token',
      fields: [
        ['grant_type', 'urn:ietf:params:oauth:grant-type:token-exchange'],
        ['subject_token', 'subject-token-1'],
        ['subject_token_type', 'urn:ietf:params:oauth:token-type:access_token'],
      ],
      client: client1,
    },
    { path: '/token', fields: [['grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer'], ['assertion', 'assertion-1']], client: client1 },
    { path: '/token', fields: [['grant_type', 'unknown_grant']], client: client1 },
  ];
  return templates.filter((template) => template.fields.length > 0);
}

/** The templates of each endpoint tried. */
const TEMPLATES: Readonly<Record<string, () => FormTemplate[]>> = { token: tokenTemplates };

/**
 * The requests to try at an endpoint, in the order to try them: the
 * requests a client sends first, then the requests made of each by changing
 * one place, each once. None for an endpoint not tried.
 */
export function candidateRequests(endpoint: string): SandboxRequest[] {
  const templates = TEMPLATES[endpoint]?.() ?? [];
  const seen = new Set<string>();
  const requests: SandboxRequest[] = [];
  for (const request of [...templates.map((template) => formRequest(template.path, template.fields, template.client)), ...templates.flatMap(variants)]) {
    const key = JSON.stringify(request);
    if (seen.has(key)) continue;
    seen.add(key);
    requests.push(request);
  }
  return requests;
}
