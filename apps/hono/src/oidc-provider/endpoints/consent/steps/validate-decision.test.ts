import { describe, expect, it } from 'vitest';
import { validateConsentDecision } from './validate-decision.js';

// OIDC Core 1.0 §3.1.2.4: the affirmative decision is detected on an allowlist.
describe('validateConsentDecision', () => {
  it('should accept approve', () => {
    expect(validateConsentDecision('approve')).toBeUndefined();
  });

  it('should answer invalid_decision for a missing decision', () => {
    expect(validateConsentDecision('')).toEqual({ kind: 'invalid_decision' });
  });

  it('should answer invalid_decision for a value that only differs in case', () => {
    expect(validateConsentDecision('Approve')).toEqual({ kind: 'invalid_decision' });
  });

  // OIDC Core 1.0 §3.1.2.6: deny is handled before this step, so it is never an approval here.
  it('should answer invalid_decision for deny', () => {
    expect(validateConsentDecision('deny')).toEqual({ kind: 'invalid_decision' });
  });
});
