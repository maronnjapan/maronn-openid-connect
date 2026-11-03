/**
 * The view in the URL hash, so a trace can be linked as it is:
 *
 *     #<framework>--<endpoint>[--<step>][/<frame>]...[;d=<decision>:<side>,...]...[;e][;f=<frame>]
 *     #<framework>--fn--<name>[--<package>--<module>][/<frame>]...[;...]
 *     #<framework>--changes   (#changes too)
 *
 * A frame is the chain of call nodes that opened it, joined with dots
 * (`/s0b1s0/s0b1s0.s2`); a decision is keyed by its frame and node the same
 * way (`d=s0b8s0:nullish,s0b1s0.s1:true`), and each `;d=` is one choice (several
 * are their union). `;e` shows where failures are caught; `;f=` names the
 * frame the diagram shows. Ids and names are letters, digits and hyphens, so
 * `--` separates them; a module is written URI-encoded.
 */
import type { Decisions, MapData } from '../types';
import { cardsNamed } from './model';
import { EMPTY_TRACE, type TraceState } from './trace';

export interface View {
  framework: string;
  endpoint: string | null;
  /** The step of the endpoint whose detail is open. */
  step: string | null;
  /** The id of the function whose page is open; null on the page of an endpoint. */
  fn: string | null;
  /** The page of the changes of the pull request is open (when no function is). */
  changes?: boolean;
  trace: TraceState;
}

/** The part of a hash that names the page of the changes of the pull request. */
const CHANGES = 'changes';

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** The trace part of a hash: the frames, the choices, the errors and the focus. */
export function traceHash(trace: TraceState): string {
  let hash = trace.open.map((key) => `/${key}`).join('');
  for (const choice of trace.choices) {
    const pairs = Object.entries(choice).map(([key, side]) => `${key}:${encodeURIComponent(side)}`);
    if (pairs.length > 0) hash += `;d=${pairs.join(',')}`;
  }
  if (trace.errors) hash += ';e';
  if (trace.focus !== '') hash += `;f=${trace.focus}`;
  return hash;
}

/** Read the trace part of a hash. */
export function parseTrace(part: string): TraceState {
  const [frames = '', ...options] = part.split(';');
  const open = frames.split('/').filter((key) => /^[a-z0-9]+(\.[a-z0-9]+)*$/.test(key));
  const choices: Decisions[] = [];
  let errors = false;
  let focus = '';
  for (const option of options) {
    if (option === 'e') errors = true;
    else if (option.startsWith('f=')) focus = option.slice(2);
    else if (option.startsWith('d=')) {
      const choice: Decisions = {};
      for (const pair of option.slice(2).split(',')) {
        // A decision key never holds a colon; the side after it is encoded.
        const at = pair.indexOf(':');
        if (at <= 0) continue;
        choice[pair.slice(0, at)] = decode(pair.slice(at + 1));
      }
      if (Object.keys(choice).length > 0) choices.push(choice);
    }
  }
  return { open: [...new Set(open)], choices, errors, focus };
}

export function buildHash(view: View, data: MapData): string {
  const trace = traceHash(view.trace);
  if (view.fn !== null) {
    const card = data.functions[view.fn];
    if (card === undefined) return '';
    const unique = cardsNamed(data, card.name).length === 1;
    return `${view.framework}--fn--${card.name}${unique ? '' : `--${card.package}--${encodeURIComponent(card.module)}`}${trace}`;
  }
  if (view.changes === true) return `${view.framework}--${CHANGES}`;
  if (view.endpoint !== null) return `${view.framework}--${view.endpoint}${view.step === null ? '' : `--${view.step}`}${trace}`;
  return '';
}

/** The function a hash names after `fn`: by name, narrowed by package and module when given. */
function functionOf(data: MapData, parts: readonly string[]): string | undefined {
  const [name, root, ...module] = parts;
  if (name === undefined || name === '') return undefined;
  const cards = cardsNamed(data, name);
  if (root !== undefined && module.length > 0) {
    const card = cards.find((candidate) => candidate.package === root && candidate.module === decode(module.join('--')));
    if (card !== undefined) return card.id;
  }
  return cards[0]?.id;
}

/** The view a hash names, over the given defaults; an unknown hash changes nothing. */
export function parseHash(hash: string, data: MapData, defaults: View): View {
  const text = hash.replace(/^#/, '');
  const cut = text.search(/[/;]/);
  const head = cut === -1 ? text : text.slice(0, cut);
  const trace = cut === -1 ? EMPTY_TRACE : parseTrace(text.slice(cut));
  const parts = head.split('--').map(decode);
  if (parts[0] === CHANGES && parts.length === 1) return { framework: defaults.framework, endpoint: null, step: null, fn: null, changes: true, trace: EMPTY_TRACE };
  if (parts[0] === 'fn') {
    const fn = functionOf(data, parts.slice(1));
    return fn === undefined ? defaults : { ...defaults, fn, trace };
  }
  const framework = parts[0];
  if (framework === undefined || !data.frameworks.includes(framework)) return defaults;
  if (parts[1] === 'fn') {
    const fn = functionOf(data, parts.slice(2));
    return fn === undefined ? { ...defaults, framework } : { ...defaults, framework, fn, trace };
  }
  const view: View = { framework, endpoint: null, step: null, fn: null, trace };
  const flow = data.flows[framework];
  const endpoint = flow?.endpoints.find((candidate) => candidate.id === parts[1]);
  if (endpoint === undefined) return parts[1] === CHANGES ? { ...view, changes: true, trace: EMPTY_TRACE } : { ...view, trace: EMPTY_TRACE };
  view.endpoint = endpoint.id;
  if (parts[2] && endpoint.steps.some((step) => step.id === parts[2])) view.step = parts[2];
  return view;
}
