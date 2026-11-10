import type { ReactNode } from 'react';
import type { ClientDisplay } from './client-display';

/**
 * 画面に表示するクライアントの名前を返す。
 *
 * `client_name` があればそれを、なければ `client_id` を返す（OIDC Dynamic Client Registration 1.0 §2）。
 *
 * @spec OIDC Dynamic Client Registration 1.0 §2
 */
export function clientDisplayName(client: ClientDisplay): string {
  return client.name ?? client.clientId;
}

/**
 * 認可を求めるクライアントのロゴと、画面の文（`children`）と、ポリシーと利用規約のリンクを描画する。
 *
 * 画面の文には、クライアントの名前（{@link clientDisplayName}）を入れる。
 * `logo_uri` は画像（`img`）に、`policy_uri`、`tos_uri`、`client_uri` はリンク（`a`、新しいタブで開き、参照元を送らない）にする（OIDC Dynamic Client Registration 1.0 §2）。
 * URL は、client-display.ts が表示してよいものに絞ってから渡す。
 * 値はどれも React が属性と本文でエスケープする。
 *
 * @spec OIDC Dynamic Client Registration 1.0 §2
 */
export function ClientSummary({ client, children }: { client: ClientDisplay; children?: ReactNode }) {
  const links = [
    { href: client.clientUri, label: 'Home page' },
    { href: client.policyUri, label: 'Privacy policy' },
    { href: client.tosUri, label: 'Terms of service' },
  ].filter((link): link is { href: string; label: string } => link.href !== undefined);
  return (
    <section className="client">
      {client.logoUri === undefined ? null : (
        // The logo is any image the client registered; next/image would need its host configured.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={client.logoUri} alt={`${clientDisplayName(client)} logo`} width={64} height={64} />
      )}
      <p>{children}</p>
      {links.length === 0 ? null : (
        <p>
          {links.map((link) => (
            <a key={link.label} href={link.href} target="_blank" rel="noopener noreferrer">
              {link.label}
            </a>
          ))}
        </p>
      )}
    </section>
  );
}
