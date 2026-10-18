import { describe, expect, it } from 'vitest';
import { formPost, providerContext } from '../../../../test-support/context.js';
import { rejectCrossOriginFormPost } from './reject-cross-origin-post.js';

const CROSS_ORIGIN_ERROR = {
  kind: 'error',
  error: 'This form can only be submitted from the authorization server itself.',
  statusCode: 403,
};

async function contextWith(headers: Record<string, string>) {
  const { c } = await providerContext({ request: formPost('/login', { csrf_token: 'csrf' }, headers) });
  return c;
}

describe('rejectCrossOriginFormPost', () => {
  it('should accept a form posted from the OP itself', async () => {
    expect(rejectCrossOriginFormPost(await contextWith({ 'Sec-Fetch-Site': 'same-origin' }))).toBeUndefined();
  });

  it('should refuse a form posted from a sibling subdomain with 403', async () => {
    expect(rejectCrossOriginFormPost(await contextWith({ 'Sec-Fetch-Site': 'same-site' }))).toEqual(
      CROSS_ORIGIN_ERROR,
    );
  });

  it('should compare Origin with config.issuer when Sec-Fetch-Site is absent', async () => {
    expect(rejectCrossOriginFormPost(await contextWith({ Origin: 'https://op.example.com' }))).toBeUndefined();
    expect(rejectCrossOriginFormPost(await contextWith({ Origin: 'https://evil.example.com' }))).toEqual(
      CROSS_ORIGIN_ERROR,
    );
  });

  it('should accept a POST that carries neither header', async () => {
    expect(rejectCrossOriginFormPost(await contextWith({}))).toBeUndefined();
  });
});
