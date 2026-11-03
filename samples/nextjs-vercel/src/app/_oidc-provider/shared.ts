/**
 * `name` の値を、プロセス全体で一度だけ作って返す。
 *
 * 値は `globalThis` に `name` の名前で保存し、最初の呼び出しだけが `create()` を呼ぶ。
 * 以後の呼び出しは、どのモジュールの層からでも、その値を返す。
 *
 * Next.js はモジュールを層（ルートハンドラ、サーバーアクションとページ、`instrumentation.ts`）ごとに一度ずつ読み込むので、モジュールの最上位で作った値は層ごとに別のものになる。
 * そのままでは、`instrumentation.ts` で変えた設定がルートハンドラに届かない。
 */
export function shared<T>(name: string, create: () => T): T {
  const registry = globalThis as typeof globalThis & { __oidcShared?: Map<string, unknown> };
  const values = (registry.__oidcShared ??= new Map<string, unknown>());
  if (!values.has(name)) values.set(name, create());
  return values.get(name) as T;
}
