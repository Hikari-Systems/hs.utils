/**
 * Shared store contracts for the MCP OAuth resource-server middleware.
 *
 * Two implementations exist:
 *   - in-memory factories in this file (good for tests and single-instance deploys)
 *   - HTTP-backed factories in `./dbStores` that call out to mcp-data-service
 *     (production multi-instance default)
 *
 * Every factory returns an async-shaped object so callers can swap freely.
 */

export type ClientRegistration = {
  client_id: string;
  client_id_issued_at: number;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
};

export type ClientStore = {
  get(id: string): Promise<ClientRegistration | undefined>;
  set(id: string, reg: ClientRegistration): Promise<void>;
};

export type DcrRateLimitStore = {
  /** Atomically record an attempt from `ip` and return whether it is allowed
   *  under a sliding-window limit of `max` per `windowMs`. */
  recordAndCheck(ip: string, windowMs: number, max: number): Promise<boolean>;
};

/** Full JWKS document — opaque to us, passed straight to jose. */
export type JsonWebKeySet = { keys: unknown[] };

export type JwksCacheEntry = {
  jwksUri: string;
  jwks: JsonWebKeySet;
};

export type JwksCache = {
  get(authServerUrl: string): Promise<JwksCacheEntry | undefined>;
  set(
    authServerUrl: string,
    jwksUri: string,
    jwks: JsonWebKeySet,
  ): Promise<void>;
};

export type AsmCacheBody = Record<string, unknown>;

export type AsmCache = {
  /** Returns the cached body if present and younger than `ttlMs`. */
  get(asmUri: string, ttlMs: number): Promise<AsmCacheBody | undefined>;
  set(asmUri: string, body: AsmCacheBody): Promise<void>;
};

// ─── In-memory implementations ──────────────────────────────────────────────

export const createClientStore = (): ClientStore => {
  const store = new Map<string, ClientRegistration>();
  return {
    get: async (id) => store.get(id),
    set: async (id, reg) => {
      store.set(id, reg);
    },
  };
};

export const createDcrRateLimitStore = (): DcrRateLimitStore => {
  const store = new Map<string, number[]>();
  return {
    recordAndCheck: async (ip, windowMs, max) => {
      const now = Date.now();
      const window = (store.get(ip) ?? []).filter((t) => now - t < windowMs);
      if (window.length >= max) {
        store.set(ip, window);
        return false;
      }
      window.push(now);
      store.set(ip, window);
      return true;
    },
  };
};

export const createJwksCache = (): JwksCache => {
  const store = new Map<string, JwksCacheEntry>();
  return {
    get: async (authServerUrl) => store.get(authServerUrl),
    set: async (authServerUrl, jwksUri, jwks) => {
      store.set(authServerUrl, { jwksUri, jwks });
    },
  };
};

export const createAsmCache = (): AsmCache => {
  const store = new Map<string, { fetchedAt: number; body: AsmCacheBody }>();
  return {
    get: async (asmUri, ttlMs) => {
      const entry = store.get(asmUri);
      if (!entry) return undefined;
      if (Date.now() - entry.fetchedAt >= ttlMs) return undefined;
      return entry.body;
    },
    set: async (asmUri, body) => {
      store.set(asmUri, { fetchedAt: Date.now(), body });
    },
  };
};
