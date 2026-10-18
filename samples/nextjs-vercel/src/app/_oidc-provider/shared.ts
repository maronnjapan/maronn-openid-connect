/**
 * One value for the whole server process.
 *
 * Next.js loads a module once per module layer (Route Handlers, Server
 * Actions and pages, instrumentation.ts), so a value created at module level
 * exists once per layer: a setting changed in instrumentation.ts would not
 * reach the Route Handlers. shared() keeps the value on globalThis under its
 * name, so every layer gets the one the first of them created.
 */
export function shared<T>(name: string, create: () => T): T {
  const registry = globalThis as typeof globalThis & { __oidcShared?: Map<string, unknown> };
  const values = (registry.__oidcShared ??= new Map<string, unknown>());
  if (!values.has(name)) values.set(name, create());
  return values.get(name) as T;
}
