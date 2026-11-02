/**
 * The view in the URL hash, so a step or a function can be linked:
 * `#<framework>--<endpoint>`, `#<framework>--<endpoint>--<step>`, `#fn--<name>`.
 * Ids and names are letters, digits and hyphens, so `--` separates them.
 */
import type { MapData } from '../types';
import { cardsNamed } from './model';

export interface View {
  framework: string;
  endpoint: string | null;
  step: string | null;
  fn: string | null;
}

export function buildHash(view: View, data: MapData): string {
  if (view.fn !== null) {
    const card = data.functions[view.fn];
    return card === undefined ? '' : `fn--${card.name}`;
  }
  if (view.endpoint !== null) return `${view.framework}--${view.endpoint}${view.step === null ? '' : `--${view.step}`}`;
  return '';
}

/** The view a hash names, over the given defaults; an unknown hash changes nothing. */
export function parseHash(hash: string, data: MapData, defaults: View): View {
  const parts = hash.replace(/^#/, '').split('--');
  if (parts[0] === 'fn' && parts[1]) {
    const found = cardsNamed(data, parts[1]);
    if (found.length > 0) return { ...defaults, fn: found[0]!.id };
    return defaults;
  }
  const framework = parts[0];
  if (framework === undefined || !data.frameworks.includes(framework)) return defaults;
  const view: View = { ...defaults, framework, endpoint: null, step: null, fn: null };
  const flow = data.flows[framework];
  const endpoint = flow?.endpoints.find((candidate) => candidate.id === parts[1]);
  if (endpoint === undefined) return view;
  view.endpoint = endpoint.id;
  if (parts[2] && endpoint.steps.some((step) => step.id === parts[2])) view.step = parts[2];
  return view;
}
