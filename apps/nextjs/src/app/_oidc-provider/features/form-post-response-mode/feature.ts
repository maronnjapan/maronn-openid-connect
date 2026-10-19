import { defineFeature } from '../../feature';
import { FORM_POST_RESPONSE_MODE_NAME, formPostResponseModeHandler } from './response-mode';

/**
 * OAuth 2.0 Form Post Response Mode: the authorization endpoint resolves
 * response_mode=form_post in its (feature: form-post-response-mode) block, and
 * the consent decision answers in that mode through the response mode
 * handler. A request that does not ask for form_post is answered exactly as
 * before.
 */
export const formPostResponseMode = defineFeature({
  id: 'form-post-response-mode',
  authorize: { responseModes: [formPostResponseModeHandler] },
  // OIDC Discovery 1.0 §3: advertised alongside query.
  discovery: () => ({ response_modes_supported: [FORM_POST_RESPONSE_MODE_NAME] }),
});
