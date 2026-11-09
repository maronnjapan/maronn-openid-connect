/** Feature ownership beside code and the tests that directly check it. */
import { featureCondition, featureLabel } from '../lib/features';
import { formatHash } from '../lib/route';
import { useApp } from './app-context';

export function FeatureBadge({ id, test = false, link = false }: { id?: string; test?: boolean; link?: boolean }) {
  const { db } = useApp();
  if (id === undefined) return null;
  const feature = db.features.find((candidate) => candidate.id === id);
  const label = featureLabel(feature, id);
  const title = `${test ? `機能 ${id} を確かめるテスト` : `機能 ${id} のコード`}（${featureCondition(feature, id)}）`;
  return link ? (
    <a className="feature-badge" href={formatHash({ page: 'search', q: feature?.flag || id })} title={title}>{label}</a>
  ) : (
    <span className="feature-badge" title={title}>{label}</span>
  );
}

export function TestFeatures({ ids, link }: { ids?: readonly string[]; link?: boolean }) {
  if (ids === undefined || ids.length === 0) return null;
  return <span className="test-features" aria-label="確かめる機能">{ids.map((id) => <FeatureBadge key={id} id={id} test link={link} />)}</span>;
}
