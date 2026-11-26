/**
 * The view in the URL hash, so a trace can be linked as it is:
 *
 *     #<framework>--<endpoint>[--<step>][/<frame>]...[;d=<decision>:<side>,...]...[;w=<way>][;e][;f=<frame>][;p][;r=<request>][;x=<exchange>]
 *     #<framework>--fn--<name>[--<package>--<module>][/<frame>]...[;...]
 *     #<framework>--changes   (#changes too)
 *     #<framework>--wiring    (#wiring too)
 *     #<framework>--history[--<change>]   (#history too; a change is `pr-<number>` or the start of a commit)
 *
 * A frame is the chain of call nodes that opened it, joined with dots
 * (`/s0b1s0/s0b1s0.s2`); a decision is keyed by its frame and node the same
 * way (`d=s0b8s0:nullish,s0b1s0.s1:true`), and each `;d=` is one choice (several
 * are their union). A call keyed the same way with the side `fails`
 * (`d=s0b1s0:fails`) fails there. `;w=` names an explicitly chosen path;
 * `;e` shows where failures are caught;
 * `;f=` names the frame the diagram shows; `;p` opens the trace as a
 * playback (the flow view); `;r=` names the case selected, and `;x=` the
 * exchange of the live OP the flow view replays (a request of the reader's
 * workspace, opened on reload). Ids and names are letters,
 * digits and hyphens, so `--` separates them; a module is written
 * URI-encoded.
 */
import type { Decisions, MapData } from '../types';
import { cardsNamed } from './model';
import { EMPTY_TRACE, type TraceState } from './trace';

export interface View {
  framework: string;
  endpoint: string | null;
  /** A step of the endpoint the hash names (`#hono--token--select-signing-keys`): the trace selects its row and shows it, and the page turns on the feature that adds it. */
  step: string | null;
  /** The id of the function whose page is open; null on the page of an endpoint. */
  fn: string | null;
  /** The page of the changes of the pull request is open (when no function is). */
  changes?: boolean;
  /** The inventory of wiring whose endpoint destination the analysis cannot establish. */
  wiring?: boolean;
  /** The history of main: '' for the list of its changes, else the key of one change (`pr-207`, the start of a commit). */
  history?: string;
  trace: TraceState;
  /** A node the trace selects once it shows, keyed like a decision (the changed node a way leads to); not in the hash. */
  target?: string;
}

/** A view without the node it asked its trace to select (View.target): what a view another page opens starts from. */
export function plainView(view: View): View {
  const next = { ...view };
  delete next.target;
  return next;
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
  if (trace.way !== undefined) hash += `;w=${encodeURIComponent(trace.way)}`;
  if (trace.errors) hash += ';e';
  if (trace.focus !== '') hash += `;f=${trace.focus}`;
  if (trace.flow === true) hash += ';p';
  if (trace.request !== undefined) hash += `;r=${encodeURIComponent(trace.request)}`;
  if (trace.exchange !== undefined) hash += `;x=${encodeURIComponent(trace.exchange)}`;
  return hash;
}

/** Read the trace part of a hash. */
export function parseTrace(part: string): TraceState {
  const [frames = '', ...options] = part.split(';');
  const open = frames.split('/').filter((key) => /^[a-z0-9]+(\.[a-z0-9]+)*$/.test(key));
  const choices: Decisions[] = [];
  let way: string | undefined;
  let request: string | undefined;
  let exchange: string | undefined;
  let errors = false;
  let focus = '';
  let flow = false;
  for (const option of options) {
    if (option === 'e') errors = true;
    else if (option === 'p') flow = true;
    else if (option.startsWith('w=') && option.length > 2) way = decode(option.slice(2));
    else if (option.startsWith('r=') && option.length > 2) request = decode(option.slice(2));
    else if (option.startsWith('x=') && option.length > 2) exchange = decode(option.slice(2));
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
  return { open: [...new Set(open)], choices, errors, focus, ...(way === undefined ? {} : { way }), ...(flow ? { flow: true } : {}), ...(request === undefined ? {} : { request }), ...(exchange === undefined ? {} : { exchange }) };
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
  if (view.wiring === true) return `${view.framework}--wiring`;
  if (view.history !== undefined) return `${view.framework}--history${view.history === '' ? '' : `--${view.history}`}`;
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

/** The change of the history a hash names after `history`: its key, or '' for the list. */
function historyKey(parts: readonly string[]): string {
  const key = parts.join('--');
  return /^(pr-\d+|[0-9a-f]{7,40})$/.test(key) ? key : '';
}

/** The view a hash names, over the given defaults; an unknown hash changes nothing. */
export function parseHash(hash: string, data: MapData, defaults: View): View {
  const text = hash.replace(/^#/, '');
  const cut = text.search(/[/;]/);
  const head = cut === -1 ? text : text.slice(0, cut);
  const trace = cut === -1 ? EMPTY_TRACE : parseTrace(text.slice(cut));
  const parts = head.split('--').map(decode);
  if (parts[0] === CHANGES && parts.length === 1) return { framework: defaults.framework, endpoint: null, step: null, fn: null, changes: true, trace: EMPTY_TRACE };
  if (parts[0] === 'wiring' && parts.length === 1) return { framework: defaults.framework, endpoint: null, step: null, fn: null, wiring: true, trace: EMPTY_TRACE };
  if (parts[0] === 'history') return { framework: defaults.framework, endpoint: null, step: null, fn: null, history: historyKey(parts.slice(1)), trace: EMPTY_TRACE };
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
  if (parts[1] === 'history') return { ...view, history: historyKey(parts.slice(2)), trace: EMPTY_TRACE };
  const endpoint = flow?.endpoints.find((candidate) => candidate.id === parts[1]);
  if (endpoint === undefined) return parts[1] === CHANGES ? { ...view, changes: true, trace: EMPTY_TRACE } : parts[1] === 'wiring' ? { ...view, wiring: true, trace: EMPTY_TRACE } : { ...view, trace: EMPTY_TRACE };
  view.endpoint = endpoint.id;
  if (parts[2] && endpoint.steps.some((step) => step.id === parts[2])) view.step = parts[2];
  return view;
}
