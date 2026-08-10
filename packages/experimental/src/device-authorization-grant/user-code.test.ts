import { describe, expect, it } from 'vitest';
import {
  formatUserCode,
  generateUniqueUserCode,
  generateUserCode,
  normalizeUserCode,
} from './user-code.js';
import { USER_CODE_CHARSET } from './store.js';
import { createInMemoryDeviceAuthorizationStore, makeRecord } from './test-helpers.js';

describe('generateUserCode', () => {
  describe('Character set and length (RFC 8628 §6.1)', () => {
    it('should return a code of exactly 9 characters including the separator', () => {
      expect(generateUserCode()).toHaveLength(9);
    });

    it('should format the code as XXXX-XXXX', () => {
      expect(/^[A-Z]{4}-[A-Z]{4}$/.test(generateUserCode())).toBe(true);
    });

    it('should only use characters from the RFC 8628 base-20 charset', () => {
      const offCharset = new Set<string>();
      for (let i = 0; i < 200; i++) {
        for (const char of generateUserCode().replace('-', '')) {
          if (!USER_CODE_CHARSET.includes(char)) offCharset.add(char);
        }
      }

      expect([...offCharset]).toEqual([]);
    });

    it('should produce every charset character across enough samples', () => {
      // rejection sampling が特定の文字を落としていないことの確認。
      const seen = new Set<string>();
      for (let i = 0; i < 2000; i++) {
        for (const char of generateUserCode().replace('-', '')) seen.add(char);
      }

      expect([...seen].sort().join('')).toBe([...USER_CODE_CHARSET].sort().join(''));
    });

    it('should not repeat the same code across consecutive calls', () => {
      expect(generateUserCode() === generateUserCode()).toBe(false);
    });
  });
});

describe('formatUserCode', () => {
  it('should insert a hyphen between the two 4-character groups', () => {
    expect(formatUserCode('WDJBMJHT')).toBe('WDJB-MJHT');
  });
});

describe('normalizeUserCode', () => {
  it('should upper-case a lower-case code', () => {
    expect(normalizeUserCode('wdjbmjht')).toBe('WDJBMJHT');
  });

  it('should strip the display hyphen', () => {
    expect(normalizeUserCode('WDJB-MJHT')).toBe('WDJBMJHT');
  });

  it('should strip spaces around and inside the code', () => {
    expect(normalizeUserCode(' wdjb mjht ')).toBe('WDJBMJHT');
  });

  it('should strip a full-width space', () => {
    expect(normalizeUserCode('WDJB　MJHT')).toBe('WDJBMJHT');
  });

  it('should leave an already normalized code unchanged', () => {
    expect(normalizeUserCode('WDJBMJHT')).toBe('WDJBMJHT');
  });

  it('should return an empty string for an empty input', () => {
    expect(normalizeUserCode('')).toBe('');
  });
});

describe('generateUniqueUserCode', () => {
  it('should return the normalized key alongside the display form', async () => {
    const store = createInMemoryDeviceAuthorizationStore();

    const result = await generateUniqueUserCode(store);

    expect(result.userCode).toBe(result.userCodeDisplay.replace('-', ''));
  });

  it('should retry until it finds a code that is not already stored', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    const lookups: string[] = [];
    let calls = 0;
    const collidingStore = {
      ...store,
      async findByUserCode(userCode: string) {
        lookups.push(userCode);
        calls++;
        // 最初の 2 回だけ衝突しているように見せる。
        return calls <= 2 ? makeRecord({ userCode }) : null;
      },
    };

    const result = await generateUniqueUserCode(collidingStore);

    expect(lookups).toEqual([lookups[0], lookups[1], result.userCode]);
  });

  it('should throw after the attempt limit when every generated code collides', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    const alwaysCollidingStore = {
      ...store,
      async findByUserCode(userCode: string) {
        return makeRecord({ userCode });
      },
    };

    await expect(generateUniqueUserCode(alwaysCollidingStore, 3)).rejects.toThrow(
      'Failed to generate a unique user_code after 3 attempts',
    );
  });

  it('should not include the generated code in the collision error message', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    const generated: string[] = [];
    const alwaysCollidingStore = {
      ...store,
      async findByUserCode(userCode: string) {
        generated.push(userCode);
        return makeRecord({ userCode });
      },
    };

    const error = await generateUniqueUserCode(alwaysCollidingStore, 2).catch((e: Error) => e);

    expect(generated.some((code) => (error as Error).message.includes(code))).toBe(false);
  });
});
