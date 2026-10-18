import { authenticateParClient, rejectForbiddenParParams } from '@maronn-openid-connect/experimental/par';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'authenticate-client',
  endpoint: 'par',
  feature: 'par',
  kind: 'validate',
  label: 'Authenticate the pushing client',
  spec: 'RFC 9126 §2.1',
  function: 'authenticatePushingClient',
  calls: ['rejectForbiddenParParams', 'authenticateParClient'],
  consumes: ['params', 'authorization'],
  produces: ['clientId', 'pushedParams'],
  removable: false,
});

/**
 * Authenticate the pushing client exactly like the token endpoint does
 * (public clients present only client_id), after refusing the parameters a
 * pushed request must not carry. RFC 9126 §2.1
 *
 * client_id is a required authorization request parameter, so the pushed
 * parameters are pinned to the authenticated client before validation.
 */
export async function authenticatePushingClient(
  c: any,
  params: Record<string, string>,
  authorization: string,
): Promise<{ clientId: string; pushedParams: Record<string, string> }> {
  const clientResolver = c.get('clientResolver');

  // RFC 9126 §2.1: request_uri MUST NOT be pushed. The request parameter
  // (PAR + JAR, §3) is not supported by this generated provider.
  rejectForbiddenParParams(params);

  const clientId = await authenticateParClient({
    params,
    authorizationHeader: authorization,
    clientResolver,
  });

  return { clientId, pushedParams: { ...params, client_id: clientId } };
}
