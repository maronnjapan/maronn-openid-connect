import type { MapFeature } from '../types';
import { featureOf, generatedWhen } from '../lib/model';

/** Name the feature of generated code, or the feature a dedicated implementation belongs to. */
export function FeatureBadge({ features, feature, implementation = false }: { features: readonly MapFeature[]; feature: string | undefined; implementation?: boolean }) {
  if (feature === undefined) return null;
  const entry = featureOf(features, feature);
  const id = entry?.id ?? feature;
  const label = implementation ? `${id} の実装` : entry?.tier === 'stable' ? `${id}（既定）` : `--enable ${id}`;
  const condition = `${implementation ? `${id} に属する実装。機能の生成条件: ` : ''}${generatedWhen(features, feature)}`;
  return <span className="feature-badge" data-feature={id} title={`${condition}${entry === undefined ? '' : `。${entry.summary}`}`}>{label}</span>;
}
