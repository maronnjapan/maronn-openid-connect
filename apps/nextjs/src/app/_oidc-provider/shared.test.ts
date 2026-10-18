import { describe, expect, it, vi } from 'vitest';
import { shared } from './shared';

// Every test uses names of its own: the values stay on globalThis for the
// whole test file, as they do for the whole server process.

describe('shared', () => {
  it('should return the value create returns on the first call for a name', () => {
    const value = { setting: 1 };

    expect(shared('shared-test:first', () => value)).toBe(value);
  });

  it('should return the same value on every call for a name, creating it once', () => {
    const create = vi.fn(() => ({ setting: 1 }));

    const first = shared('shared-test:once', create);
    const second = shared('shared-test:once', create);
    const third = shared('shared-test:once', () => ({ setting: 2 }));

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('should keep a change made to the value for the next call', () => {
    shared('shared-test:changed', () => ({ setting: 1 })).setting = 5;

    expect(shared('shared-test:changed', () => ({ setting: 1 }))).toEqual({ setting: 5 });
  });

  it('should keep separate values for different names', () => {
    const one = shared('shared-test:one', () => ({ name: 'one' }));
    const two = shared('shared-test:two', () => ({ name: 'two' }));

    expect([one, two]).toEqual([{ name: 'one' }, { name: 'two' }]);
    expect(two).not.toBe(one);
  });

  // Next.js loads a module once per module layer: a fresh copy of the module
  // still gets the value the first layer created.
  it('should return the value created before the module was loaded again', async () => {
    const value = shared('shared-test:reloaded', () => ({ setting: 1 }));
    vi.resetModules();

    const reloaded = await import('./shared');

    expect(reloaded.shared).not.toBe(shared);
    expect(reloaded.shared('shared-test:reloaded', () => ({ setting: 2 }))).toBe(value);
  });

  it('should keep a value of undefined instead of creating it again', () => {
    const create = vi.fn(() => undefined);

    shared('shared-test:undefined', create);
    shared('shared-test:undefined', create);

    expect(create).toHaveBeenCalledTimes(1);
  });
});
