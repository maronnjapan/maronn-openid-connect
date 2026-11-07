/** The tests matching the words of the header's search box; in the build of a pull request, with the tests it removed that match them. */
import { useMemo } from 'react';
import { sortForList } from '../lib/data';
import { searchRemoved, searchTests } from '../lib/filter';
import { formatCount } from '../lib/format';
import { useApp, useTitle } from './app-context';
import { TestList } from './TestList';

export function SearchPage() {
  const { db, view } = useApp();
  const query = view.q ?? '';
  useTitle(`「${query}」の検索結果`);
  const found = useMemo(() => sortForList(searchTests(db, query)), [db, query]);
  const removed = useMemo(() => searchRemoved(db, query), [db, query]);
  return (
    <div className="page search-page">
      <header className="page-head">
        <h1>「{query}」の検索結果</h1>
        <p className="lede">
          <span className="num">{formatCount(found.length)}</span> 件
        </p>
      </header>
      {found.length + removed.length === 0 ? (
        <p className="note">一致するテストはありません。英語と日本語のタイトル、ファイルのパス、describe の名前から探します。</p>
      ) : (
        <TestList tests={found} removed={removed} target={{}} />
      )}
    </div>
  );
}
