import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '../../config.js';
import { rar } from './feature.js';

const TYPE_DEFINITION = {
  type: 'payment_initiation',
  validate(): void {},
  describe(): readonly string[] {
    return [];
  },
};

describe('rar feature', () => {
  describe('discovery', () => {
    it('should advertise the configured type values as authorization_details_types_supported', () => {
      const config = { rarTypes: [TYPE_DEFINITION] } as unknown as ProviderConfig;
      expect(rar.discovery?.('https://op.example.com', config)).toEqual({
        authorization_details_types_supported: ['payment_initiation'],
      });
    });

    // RFC 9396 §10: 広告しない OP に RAR を送るべきでない。型定義が空なら member を出さない。
    it('should advertise nothing while no type definitions are configured', () => {
      expect(rar.discovery?.('https://op.example.com', {} as ProviderConfig)).toEqual({});
      expect(rar.discovery?.('https://op.example.com', { rarTypes: [] } as unknown as ProviderConfig)).toEqual({});
    });
  });

  it('should put both stores into the request context', () => {
    expect(rar.context).toHaveProperty('rarTransactionStore');
    expect(rar.context).toHaveProperty('rarGrantStore');
  });
});
