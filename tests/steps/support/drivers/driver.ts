/**
 * What an in-process target does for the steps: an OP of one app on
 * in-memory stores of its own, set up and read the way the API tests of that
 * app do (hono.ts, nextjs.ts).
 *
 * The steps only see this interface, so one step serves both apps; a driver
 * that cannot do something the interface asks for does not compile.
 */

/** A confidential client registered for the authorization_code and refresh_token grants. */
export interface ConfidentialClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** How it authenticates at the token endpoint: client_secret_basic or client_secret_post. */
  authMethod: 'client_secret_basic' | 'client_secret_post';
}

/** An authorization code as the consent step of the OP stores it, issued to a client for a user. */
export interface IssuedAuthorizationCode {
  code: string;
  clientId: string;
  redirectUri: string;
  scope: string[];
  /** The S256 code_challenge of the authorization request (RFC 7636 §4.2), if it had one. */
  codeChallenge?: string;
}

/** The OP of one app, on stores that only this scenario uses. */
export interface InProcessDriver {
  /** The issuer the OP answers on: the origin of the URLs the steps request. */
  readonly issuer: string;
  registerClient(client: ConfidentialClient): Promise<void>;
  storeAuthorizationCode(code: IssuedAuthorizationCode): Promise<void>;
  /** Whether the stored code is marked used; undefined when the store does not hold it. */
  authorizationCodeUsed(code: string): Promise<boolean | undefined>;
  /** Whether the store holds the access token, as the UserInfo and introspection endpoints read it. */
  holdsAccessToken(accessToken: string): Promise<boolean>;
  /** Whether the store holds the refresh token. */
  holdsRefreshToken(refreshToken: string): Promise<boolean>;
  /** Hands the request to the endpoint of its path, as the API tests of the app do. */
  request(request: Request): Promise<Response>;
  /** Drops the stores, so the next scenario starts from none. */
  close(): Promise<void>;
}

/** What a driver module exports: hono.ts and nextjs.ts. */
export interface InProcessDriverModule {
  openDriver(): Promise<InProcessDriver>;
}
