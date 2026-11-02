/**
 * The view in the URL hash, so an endpoint, a step or a function can be
 * linked: `#<framework>--<endpoint>`, `#<framework>--<endpoint>--<step>`,
 * `#<framework>--fn--<name>` (and `--<package>--<module>` after the name when
 * several functions share it), and `#<framework>--changes` for the changes of
 * the pull request (`#changes` too). Ids and names are letters, digits and
 * hyphens, so `--` separates them. `#fn--<name>` of earlier links still opens
 * the function.
 */
import type { MapData } from '../types';
import { cardsNamed } from './model';

export interface View {
  framework: string;
  endpoint: string | null;
  step: string | null;
  /** The id of the function whose page is open; null on the page of an endpoint. */
  fn: string | null;
  /** The page of the changes of the pull request is open (when no function is). */
  changes?: boolean;
}

/** The part of a hash that names the page of the changes of the pull request. */
const CHANGES = 'changes';

export function buildHash(view: View, data: MapData): string {
  if (view.fn !== null) {
    const card = data.functions[view.fn];
    if (card === undefined) return '';
    const unique = cardsNamed(data, card.name).length === 1;
    return `${view.framework}--fn--${card.name}${unique ? '' : `--${card.package}--${card.module}`}`;
  }
  if (view.changes === true) return `${view.framework}--${CHANGES}`;
  if (view.endpoint !== null) return `${view.framework}--${view.endpoint}${view.step === null ? '' : `--${view.step}`}`;
  return '';
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** The function a hash names after `fn`: by name, narrowed by package and module when given. */
function functionOf(data: MapData, parts: readonly string[]): string | undefined {
  const [name, root, ...module] = parts;
  if (name === undefined || name === '') return undefined;
  const cards = cardsNamed(data, name);
  if (root !== undefined && module.length > 0) {
    const card = cards.find((candidate) => candidate.package === root && candidate.module === module.join('--'));
    if (card !== undefined) return card.id;
  }
  return cards[0]?.id;
}

/** The view a hash names, over the given defaults; an unknown hash changes nothing. */
export function parseHash(hash: string, data: MapData, defaults: View): View {
  const parts = hash.replace(/^#/, '').split('--').map(decode);
  if (parts[0] === CHANGES && parts.length === 1) return { framework: defaults.framework, endpoint: null, step: null, fn: null, changes: true };
  if (parts[0] === 'fn') {
    const fn = functionOf(data, parts.slice(1));
    return fn === undefined ? defaults : { ...defaults, fn };
  }
  const framework = parts[0];
  if (framework === undefined || !data.frameworks.includes(framework)) return defaults;
  if (parts[1] === 'fn') {
    const fn = functionOf(data, parts.slice(2));
    return fn === undefined ? { ...defaults, framework } : { ...defaults, framework, fn };
  }
  const view: View = { framework, endpoint: null, step: null, fn: null };
  const flow = data.flows[framework];
  const endpoint = flow?.endpoints.find((candidate) => candidate.id === parts[1]);
  if (endpoint === undefined) return parts[1] === CHANGES ? { ...view, changes: true } : view;
  view.endpoint = endpoint.id;
  if (parts[2] && endpoint.steps.some((step) => step.id === parts[2])) view.step = parts[2];
  return view;
}
