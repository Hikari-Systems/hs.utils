import logging from '../logging';
import { ClientRegistration, ClientStore } from './stores';

const log = logging('mcp-auth:hydraClientStore');

// Hydra admin API client representation. We keep the full schema loose since
// Hydra adds optional fields and we only normalize a subset for CIMD.
type HydraClient = Record<string, unknown> & {
  client_id?: string;
  client_id_issued_at?: number;
  redirect_uris?: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
};

const toRegistration = (c: HydraClient): ClientRegistration => ({
  client_id: c.client_id ?? '',
  client_id_issued_at: c.client_id_issued_at ?? 0,
  redirect_uris: Array.isArray(c.redirect_uris) ? c.redirect_uris : [],
  grant_types: Array.isArray(c.grant_types)
    ? c.grant_types
    : ['authorization_code'],
  response_types: Array.isArray(c.response_types) ? c.response_types : ['code'],
  token_endpoint_auth_method:
    typeof c.token_endpoint_auth_method === 'string'
      ? c.token_endpoint_auth_method
      : 'none',
});

export type HydraClientStoreOpts = {
  // e.g. http://hydra:4445 (admin API, not the public OAuth endpoint).
  hydraAdminUrl: string;
};

// Read-through ClientStore backed by Hydra's admin API. Hydra owns DCR
// (RFC 7591) so writes go through Hydra's public /oauth2/register; this store
// is read-only from the resource server's perspective. `set` is a no-op
// because Hydra is the source of truth.
export const createHydraClientStore = (
  opts: HydraClientStoreOpts,
): ClientStore => {
  const adminUrl = opts.hydraAdminUrl.replace(/\/+$/, '');
  if (!adminUrl) {
    throw new Error('createHydraClientStore: hydraAdminUrl is required');
  }
  return {
    get: async (id) => {
      try {
        const r = await fetch(
          `${adminUrl}/admin/clients/${encodeURIComponent(id)}`,
          {
            headers: { Accept: 'application/json' },
          },
        );
        if (r.status === 404) return undefined;
        if (!r.ok) {
          const body = await r.text().catch(() => '');
          log.warn(
            `Hydra admin lookup for ${id} → ${r.status}: ${body.slice(0, 200)}`,
          );
          return undefined;
        }
        const c = (await r.json()) as HydraClient;
        return toRegistration(c);
      } catch (err) {
        log.error(
          `Hydra admin lookup for ${id} failed: ${(err as Error).message}`,
        );
        return undefined;
      }
    },
    set: async () => {
      // Hydra is the source of truth; clients register via Hydra's public
      // /oauth2/register endpoint, not via this store.
    },
  };
};
