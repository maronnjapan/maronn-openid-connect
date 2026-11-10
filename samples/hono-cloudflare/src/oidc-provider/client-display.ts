/**
 * What the login and consent pages show the End-User about the client asking
 * for the authorization: its client_name (the client_id without one), its
 * logo_uri as an image, and its policy_uri and tos_uri as links (OIDC Dynamic
 * Client Registration 1.0 §2, where the OP SHOULD display them). The
 * describe-login-screen and describe-consent-screen steps put it on their
 * screens, and views.tsx renders it.
 *
 * Only https URLs are shown (config.allowInsecureClientDisplayUris lets http
 * through for development), and with config.requireClientDisplayUriHostMatch
 * the logo_uri and policy_uri only when their host is the host of one of the
 * client's redirect_uris (§9.1). The views escape every value they put into
 * an attribute.
 */
import type { ClientResolver } from '@maronn-openid-connect/core';
import type { ProviderConfig, RegisteredClient } from './config.js';

/** The client as the login and consent pages show it. */
export interface ClientDisplay {
  clientId: string;
  /** client_name, when the client registered one. */
  name?: string;
  /** logo_uri, shown as an image. */
  logoUri?: string;
  /** policy_uri, shown as a link to the privacy policy. */
  policyUri?: string;
  /** tos_uri, shown as a link to the terms of service. */
  tosUri?: string;
  /** client_uri, shown as a link to the client's home page. */
  clientUri?: string;
}

/** {@link selectClientDisplayUri} の条件。 */
export interface ClientDisplayUriPolicy {
  /** `http` の URL も通す（開発用）。 */
  allowInsecure: boolean;
  /** あれば、ホストがこのどれかと一致する URL だけを通す（OIDC Dynamic Client Registration 1.0 §9.1）。 */
  allowedHosts?: readonly string[];
}

/**
 * `clientId` のクライアントを `clientResolver` で探し、ログイン画面と同意画面に表示する内容を返す。
 *
 * クライアントが見つからないときと、何も登録していないときは、`clientId` だけを返す（画面は `client_id` を表示する）。
 * 表示する URL は {@link selectClientDisplayUri} で選び、`https` でないもの（`config.allowInsecureClientDisplayUris` のときは `http` も通す）を落とす。
 * `config.requireClientDisplayUriHostMatch` が有効なら、`logo_uri` と `policy_uri` は、ホストがクライアントの `redirect_uris` のどれかのホストと一致するときだけ表示する（OIDC Dynamic Client Registration 1.0 §9.1）。
 *
 * @spec OIDC Dynamic Client Registration 1.0 §2
 * @spec OIDC Dynamic Client Registration 1.0 §9.1
 */
export async function resolveClientDisplay(
  clientResolver: ClientResolver,
  config: Pick<ProviderConfig, 'allowInsecureClientDisplayUris' | 'requireClientDisplayUriHostMatch'>,
  clientId: string,
): Promise<ClientDisplay> {
  const client = (await clientResolver.findClient(clientId)) as RegisteredClient | null;
  if (client === null) {
    return { clientId };
  }
  const anyHost: ClientDisplayUriPolicy = { allowInsecure: config.allowInsecureClientDisplayUris };
  const redirectUriHosts: ClientDisplayUriPolicy = config.requireClientDisplayUriHostMatch
    ? { ...anyHost, allowedHosts: hostsOf(client.redirectUris) }
    : anyHost;
  const logoUri = selectClientDisplayUri(client.logoUri, redirectUriHosts);
  const policyUri = selectClientDisplayUri(client.policyUri, redirectUriHosts);
  const tosUri = selectClientDisplayUri(client.tosUri, anyHost);
  const clientUri = selectClientDisplayUri(client.clientUri, anyHost);
  return {
    clientId,
    ...(client.clientName === undefined || client.clientName === '' ? {} : { name: client.clientName }),
    ...(logoUri === undefined ? {} : { logoUri }),
    ...(policyUri === undefined ? {} : { policyUri }),
    ...(tosUri === undefined ? {} : { tosUri }),
    ...(clientUri === undefined ? {} : { clientUri }),
  };
}

/**
 * 画面に表示してよい URL なら `uri` を返し、そうでなければ `undefined` を返す。
 *
 * 表示してよいのは、URL として読めて、スキームが `https`（`policy.allowInsecure` のときは `http` も）の URL である。
 * `javascript:` や `data:` のような、リンクや画像にすると危険なスキームはどれも落ちる。
 * `policy.allowedHosts` があれば、ホストがそのどれかと一致する URL だけを通す。
 *
 * @spec OIDC Dynamic Client Registration 1.0 §2
 * @spec OIDC Dynamic Client Registration 1.0 §9.1
 */
export function selectClientDisplayUri(uri: string | undefined, policy: ClientDisplayUriPolicy): string | undefined {
  if (uri === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && !(policy.allowInsecure && url.protocol === 'http:')) {
    return undefined;
  }
  if (policy.allowedHosts !== undefined && !policy.allowedHosts.includes(url.host)) {
    return undefined;
  }
  return uri;
}

/** URL のホスト（ポートを含む）を、重複なく返す。URL として読めない値は飛ばす。 */
function hostsOf(uris: readonly string[]): string[] {
  const hosts = new Set<string>();
  for (const uri of uris) {
    try {
      hosts.add(new URL(uri).host);
    } catch {
      // 読めない redirect_uri は、どのホストとも一致させない。
    }
  }
  return [...hosts];
}
