/** The labels of feature ownership and the ranges a code view marks. */
import type { TestSource, TestsOutline } from '@maronn-openid-connect/test-catalog/model';

export type FeatureInfo = NonNullable<TestsOutline['features']>[number];
export type FeatureRange = NonNullable<TestSource['features']>[number];

/** A feature's visible flag, with default features distinguished from opt-in ones. */
export function featureLabel(feature: FeatureInfo | undefined, id: string): string {
  return feature?.tier === 'stable' ? `${id} · 既定` : feature?.flag || id;
}

/** The feature's generation condition, without claiming library or test files are generated. */
export function featureCondition(feature: FeatureInfo | undefined, id: string): string {
  if (feature === undefined) return `機能 ${id} のコード`;
  return feature.tier === 'stable' ? `機能の生成条件: 既定で有効（${feature.flag} で外せる）` : `機能の生成条件: ${feature.flag}`;
}

/** The feature ranges that include a line; absent metadata leaves the code unmarked. */
export function featuresAt(ranges: readonly FeatureRange[] | undefined, line: number): FeatureRange[] {
  return (ranges ?? []).filter((range) => line >= range.lines[0] && line <= range.lines[1]);
}

/** The visible beginning of a range, including when a code panel starts inside it. */
export function startsFeature(range: FeatureRange, line: number, start: number): boolean {
  return line === Math.max(range.lines[0], start);
}
