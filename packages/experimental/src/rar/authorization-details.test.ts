import { describe, expect, it } from 'vitest';
import {
  AUTHORIZATION_DETAILS_PARAM,
  RarError,
  describeAuthorizationDetails,
  parseAuthorizationDetailsInput,
  validateAuthorizationDetails,
  type AuthorizationDetail,
  type AuthorizationDetailTypeDefinition,
} from './authorization-details.js';

const LIMITS = { maxBytes: 16384, maxEntries: 16 };

// RFC 9396 §2.1 Figure 1 の payment_initiation の例をテスト入力に使う。
const PAYMENT_DETAIL = {
  type: 'payment_initiation',
  actions: ['initiate'],
  locations: ['https://example.com/payments'],
  instructedAmount: { currency: 'EUR', amount: '123.50' },
};

// 型固有検証と表示のデモ型定義（RFC 9396 §2.1 の例の形）。
const PAYMENT_TYPE: AuthorizationDetailTypeDefinition = {
  type: 'payment_initiation',
  validate(detail: AuthorizationDetail): void {
    if (!Array.isArray(detail.actions) || detail.actions.length === 0) {
      throw new RarError('payment_initiation requires actions');
    }
  },
  describe(detail: AuthorizationDetail): readonly string[] {
    const amount = detail['instructedAmount'] as { currency: string; amount: string };
    return [`Initiate a payment of ${amount.currency} ${amount.amount}`];
  },
};

describe('AUTHORIZATION_DETAILS_PARAM', () => {
  it('should name the RFC 9396 request parameter', () => {
    expect(AUTHORIZATION_DETAILS_PARAM).toBe('authorization_details');
  });
});

describe('parseAuthorizationDetailsInput', () => {
  describe('string input (query / PAR)', () => {
    it('should parse a single-entry JSON array string', () => {
      const details = parseAuthorizationDetailsInput(JSON.stringify([PAYMENT_DETAIL]), LIMITS);
      expect(details).toEqual([PAYMENT_DETAIL]);
    });

    it('should parse multiple entries and keep duplicated types', () => {
      // RFC 9396 §2: 同じ type の要素が複数あってよい（MAY）。
      const details = parseAuthorizationDetailsInput(
        JSON.stringify([PAYMENT_DETAIL, PAYMENT_DETAIL]),
        LIMITS,
      );
      expect(details).toEqual([PAYMENT_DETAIL, PAYMENT_DETAIL]);
    });

    it('should reject a string that is not valid JSON', () => {
      expect(() => parseAuthorizationDetailsInput('{not json', LIMITS)).toThrow(RarError);
    });

    it('should reject JSON that is not an array', () => {
      expect(() => parseAuthorizationDetailsInput(JSON.stringify(PAYMENT_DETAIL), LIMITS)).toThrow(
        'authorization_details must be a JSON array',
      );
    });

    it('should reject a raw string over maxBytes measured as UTF-8', () => {
      // 多バイト文字（3 バイトの「あ」）で、文字数でなくバイト数が検査されることを確かめる。
      const padding = 'あ'.repeat(40);
      const raw = JSON.stringify([{ ...PAYMENT_DETAIL, note: padding }]);
      const onLimit = new TextEncoder().encode(raw).length;
      expect(() => parseAuthorizationDetailsInput(raw, { maxBytes: onLimit, maxEntries: 16 })).not.toThrow();
      expect(() => parseAuthorizationDetailsInput(raw, { maxBytes: onLimit - 1, maxEntries: 16 })).toThrow(
        'authorization_details is too large',
      );
    });
  });

  describe('parsed JSON input (Request Object)', () => {
    it('should accept an already-parsed array', () => {
      const details = parseAuthorizationDetailsInput([PAYMENT_DETAIL], LIMITS);
      expect(details).toEqual([PAYMENT_DETAIL]);
    });

    it('should reject a parsed value that is neither string nor array', () => {
      expect(() => parseAuthorizationDetailsInput(PAYMENT_DETAIL, LIMITS)).toThrow(
        'authorization_details must be a JSON array',
      );
      expect(() => parseAuthorizationDetailsInput(42, LIMITS)).toThrow(
        'authorization_details must be a JSON array',
      );
    });

    it('should reject undefined input', () => {
      expect(() => parseAuthorizationDetailsInput(undefined, LIMITS)).toThrow(
        'authorization_details must be a JSON value',
      );
    });

    it('should reject a parsed array whose JSON serialization is over maxBytes', () => {
      const value = [{ ...PAYMENT_DETAIL, note: 'x'.repeat(50) }];
      const onLimit = new TextEncoder().encode(JSON.stringify(value)).length;
      expect(() => parseAuthorizationDetailsInput(value, { maxBytes: onLimit, maxEntries: 16 })).not.toThrow();
      expect(() => parseAuthorizationDetailsInput(value, { maxBytes: onLimit - 1, maxEntries: 16 })).toThrow(
        'authorization_details is too large',
      );
    });
  });

  describe('array shape', () => {
    it('should reject an empty array', () => {
      expect(() => parseAuthorizationDetailsInput('[]', LIMITS)).toThrow(
        'authorization_details must not be empty',
      );
    });

    it('should reject more entries than maxEntries', () => {
      const entries = Array.from({ length: 3 }, () => PAYMENT_DETAIL);
      expect(() =>
        parseAuthorizationDetailsInput(JSON.stringify(entries), { maxBytes: 16384, maxEntries: 2 }),
      ).toThrow('authorization_details has too many entries');
    });

    it('should accept exactly maxEntries entries', () => {
      const entries = Array.from({ length: 2 }, () => PAYMENT_DETAIL);
      expect(
        parseAuthorizationDetailsInput(JSON.stringify(entries), { maxBytes: 16384, maxEntries: 2 }),
      ).toEqual(entries);
    });

    it('should reject entries that are not plain objects', () => {
      for (const entry of ['payment_initiation', ['nested'], null, 42]) {
        expect(() => parseAuthorizationDetailsInput(JSON.stringify([entry]), LIMITS)).toThrow(
          'authorization_details entries must be JSON objects',
        );
      }
    });
  });

  describe('type field (RFC 9396 §2 REQUIRED)', () => {
    it('should reject an entry without type', () => {
      expect(() => parseAuthorizationDetailsInput(JSON.stringify([{ actions: ['initiate'] }]), LIMITS)).toThrow(
        'authorization_details entries must have a non-empty type',
      );
    });

    it('should reject an empty-string type', () => {
      expect(() => parseAuthorizationDetailsInput(JSON.stringify([{ type: '' }]), LIMITS)).toThrow(
        'authorization_details entries must have a non-empty type',
      );
    });

    it('should reject a non-string type', () => {
      expect(() => parseAuthorizationDetailsInput(JSON.stringify([{ type: 7 }]), LIMITS)).toThrow(
        'authorization_details entries must have a non-empty type',
      );
    });
  });

  describe('common fields (RFC 9396 §2.2)', () => {
    it('should reject a locations value that is not an array', () => {
      expect(() =>
        parseAuthorizationDetailsInput(JSON.stringify([{ type: 'payment_initiation', locations: 'https://example.com' }]), LIMITS),
      ).toThrow('authorization_details common fields must have the RFC 9396 types');
    });

    it('should reject an identifier value that is not a string', () => {
      expect(() =>
        parseAuthorizationDetailsInput(JSON.stringify([{ type: 'payment_initiation', identifier: ['account-14'] }]), LIMITS),
      ).toThrow('authorization_details common fields must have the RFC 9396 types');
    });

    it('should reject a string-array field holding a non-string item', () => {
      expect(() =>
        parseAuthorizationDetailsInput(JSON.stringify([{ type: 'payment_initiation', actions: ['initiate', 7] }]), LIMITS),
      ).toThrow('authorization_details common fields must have the RFC 9396 types');
    });

    it('should accept all common fields with their RFC 9396 types', () => {
      const entry = {
        type: 'payment_initiation',
        locations: ['https://example.com/payments'],
        actions: ['initiate'],
        datatypes: ['transactions'],
        identifier: 'account-14',
        privileges: ['admin'],
      };
      expect(parseAuthorizationDetailsInput(JSON.stringify([entry]), LIMITS)).toEqual([entry]);
    });
  });

  describe('prototype safety (RFC 9396 §12 sanitize)', () => {
    it('should keep a __proto__ key as an own property without polluting prototypes', () => {
      const raw = '[{"type":"payment_initiation","__proto__":{"polluted":true}}]';
      const [detail] = parseAuthorizationDetailsInput(raw, LIMITS);
      expect(Object.getOwnPropertyNames(detail)).toEqual(['type', '__proto__']);
      expect(({} as Record<string, unknown>)['polluted']).toBe(undefined);
      expect(Object.getPrototypeOf(detail)).toBe(Object.prototype);
    });

    it('should keep a constructor key as data without replacing the real constructor behavior', () => {
      const raw = '[{"type":"payment_initiation","constructor":"overridden"}]';
      const [detail] = parseAuthorizationDetailsInput(raw, LIMITS);
      expect(detail['constructor']).toBe('overridden');
      expect(({} as Record<string, unknown>)['constructor']).toBe(Object);
    });
  });

  describe('error hygiene (RFC 9396 §13)', () => {
    it('should keep the input value out of the error message', () => {
      const secret = 'IBAN-DE75512108001245126199';
      let caught: unknown;
      try {
        parseAuthorizationDetailsInput(JSON.stringify([{ type: 7, account: secret }]), LIMITS);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RarError);
      expect((caught as RarError).message).toBe('authorization_details entries must have a non-empty type');
      expect((caught as RarError).message.includes(secret)).toBe(false);
    });
  });
});

describe('validateAuthorizationDetails', () => {
  it('should accept entries whose type definition validates', () => {
    expect(() => validateAuthorizationDetails([PAYMENT_DETAIL], [PAYMENT_TYPE])).not.toThrow();
  });

  it('should reject every entry when no type definitions are registered', () => {
    // fail-closed: 型定義が空なら全拒否（RFC 9396 §5）。
    expect(() => validateAuthorizationDetails([PAYMENT_DETAIL], [])).toThrow(
      'authorization_details contains an unsupported type',
    );
  });

  it('should reject an entry whose type has no definition', () => {
    const unknownDetail = { type: 'account_information' };
    expect(() => validateAuthorizationDetails([PAYMENT_DETAIL, unknownDetail], [PAYMENT_TYPE])).toThrow(
      'authorization_details contains an unsupported type',
    );
  });

  it('should propagate a RarError thrown by the type definition validate', () => {
    const invalid = { type: 'payment_initiation', actions: [] };
    expect(() => validateAuthorizationDetails([invalid], [PAYMENT_TYPE])).toThrow(
      'payment_initiation requires actions',
    );
  });

  it('should propagate a non-RarError thrown by the type definition validate', () => {
    const throwingType: AuthorizationDetailTypeDefinition = {
      type: 'payment_initiation',
      validate(): void {
        throw new TypeError('validator bug');
      },
      describe(): readonly string[] {
        return [];
      },
    };
    expect(() => validateAuthorizationDetails([PAYMENT_DETAIL], [throwingType])).toThrow(TypeError);
  });
});

describe('describeAuthorizationDetails', () => {
  it('should build the display lines in entry order', () => {
    const second = {
      ...PAYMENT_DETAIL,
      instructedAmount: { currency: 'USD', amount: '9.99' },
    };
    expect(describeAuthorizationDetails([PAYMENT_DETAIL, second], [PAYMENT_TYPE])).toEqual([
      'Initiate a payment of EUR 123.50',
      'Initiate a payment of USD 9.99',
    ]);
  });

  it('should reject an entry whose type has no definition', () => {
    expect(() => describeAuthorizationDetails([{ type: 'account_information' }], [PAYMENT_TYPE])).toThrow(
      'authorization_details contains an unsupported type',
    );
  });
});
