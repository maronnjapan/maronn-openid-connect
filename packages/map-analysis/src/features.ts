/**
 * Feature ownership is deliberately local: generator-owned directories and
 * owner blocks, never everything a feature happens to call. Library modules
 * under a feature's own directory are its implementation, not generated files.
 */
import type { FeatureRange } from './model.js';

/** The registered feature that owns a provider file or a dedicated library directory. */
export function featureOfPath(path: string, features: readonly { id: string }[]): string | undefined {
  const normalized = path.replaceAll('\\', '/');
  const id = /(?:^|\/)features\/([^/]+)\//.exec(normalized)?.[1]
    ?? /(?:^|\/)app\/\(([^/]+)\)\//.exec(normalized)?.[1]
    ?? /(?:^|\/)packages\/(?:core|experimental)\/src\/([^/]+)\//.exec(normalized)?.[1]
    ?? (/(?:^|\/)packages\/google-login\/src\//.test(normalized) ? 'google-login' : undefined);
  return features.find((feature) => feature.id === id)?.id;
}

/** Source ranges using the generator's parser, with whole-file ownership taking precedence. */
export function sourceFeatureRanges(
  path: string,
  code: string,
  features: readonly { id: string }[],
  parse: (text: string) => Array<{ feature: string | undefined; startLine: number; endLine: number }>,
  owner = featureOfPath(path, features),
): FeatureRange[] {
  if (owner !== undefined) {
    const lines = code.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines.length === 0 ? [] : [{ feature: owner, lines: [1, lines.length] }];
  }
  const known = new Set(features.map((feature) => feature.id));
  return parse(code).flatMap((block): FeatureRange[] => block.feature === undefined || !known.has(block.feature)
    ? []
    : [{ feature: block.feature, lines: [block.startLine + 1, block.endLine + 1] }]);
}
