import type { ParEndpointResponse } from '../response.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'respond',
  endpoint: 'par',
  feature: 'par',
  kind: 'respond',
  label: 'Respond 201 (no-store)',
  spec: 'RFC 9126 §2.2',
  function: 'respondPar',
  consumes: ['parResponse'],
  produces: [],
  removable: false,
});

/** RFC 9126 §2.2: a non-cacheable JSON body. */
export function respondPar(c: any, response: ParEndpointResponse): Response {
  c.header('Cache-Control', 'no-cache, no-store');
  c.header('Pragma', 'no-cache');
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    c.header(name, value);
  }
  return c.json(response.body, response.status);
}
