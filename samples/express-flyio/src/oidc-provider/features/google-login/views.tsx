/** @jsxImportSource hono/jsx */
/**
 * EXTENSION (google-login) — the view of the "Sign in with Google" button on
 * the login page, in hono/jsx.
 *
 * It is a member of Views (views.tsx), added below, so the views option of
 * createApp() / applyOidc() can replace it like the login and consent views.
 * Left out, the default of this file is used.
 */
import type { JSX } from 'hono/jsx/jsx-runtime';
import {
  GOOGLE_GSI_CLIENT_SCRIPT_URL,
  type GoogleSignInAttributes,
} from '@maronn-openid-connect/google-login/sign-in';
import type { Views } from '../../views.js';

export interface GoogleSignInParams {
  /**
   * GIS configuration for "Sign in with Google" (Google Identity Services,
   * redirect mode): the g_id_onload attributes from
   * buildGoogleSignInAttributes(): client ID, data-ux_mode="redirect", the
   * login_uri Google posts the ID token to, and the nonce bound to this
   * transaction.
   */
  googleSignIn: GoogleSignInAttributes;
}

declare module '../../views.js' {
  interface Views {
    /** EXTENSION (google-login): render the "Sign in with Google" button of the login page */
    googleSignInButton?(params: GoogleSignInParams): ViewResult;
  }
}

/*
 * The three elements GIS needs for redirect mode — its client script,
 * #g_id_onload carrying the configuration (spread as attributes, which JSX
 * escapes), and .g_id_signin, which GIS replaces with the button. Style the
 * button through the GIS button attributes (data-theme, data-size, data-text,
 * ...) on .g_id_signin. hono/jsx hoists the async script into <head>.
 */
function defaultGoogleSignInButton(params: GoogleSignInParams): JSX.Element {
  return (
    <>
      <hr />
      <section aria-label="Sign in with Google">
        <script src={GOOGLE_GSI_CLIENT_SCRIPT_URL} async></script>
        <div {...params.googleSignIn}></div>
        <div class="g_id_signin" data-type="standard"></div>
      </section>
    </>
  );
}

/** The view of the request: the one the app replaced, else the default above. */
export function googleViews(c: any): Required<Pick<Views, 'googleSignInButton'>> {
  const views: Partial<Views> = c.get('views') ?? {};
  return {
    googleSignInButton: views.googleSignInButton ?? defaultGoogleSignInButton,
  };
}
