import { describe, expect, it } from 'vitest';
import { createProviderConfig } from '../../config';
import { discoveryOf, responseModesOf } from '../../feature';
import { formPostResponseMode } from './feature';
import { formPostResponseModeHandler } from './response-mode';

describe('formPostResponseMode', () => {
  // OIDC Discovery 1.0 §3: response_modes_supported.
  it('should advertise form_post next to the response modes the provider already advertises', () => {
    const issuer = 'https://op.example.com';

    const metadata = discoveryOf(
      [formPostResponseMode],
      { response_modes_supported: ['query'] },
      issuer,
      createProviderConfig({ issuer }),
    );

    expect(metadata).toEqual({ response_modes_supported: ['query', 'form_post'] });
  });

  // Form Post Response Mode §2: the consent decision answers in the mode the transaction stored.
  it('should answer in the Form Post Response Mode at the consent decision', () => {
    expect(responseModesOf([formPostResponseMode])).toEqual([formPostResponseModeHandler]);
  });
});
