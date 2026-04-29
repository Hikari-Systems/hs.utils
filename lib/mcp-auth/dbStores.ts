import config from '../config';
import logging from '../logging';
import {
  AsmCache,
  AsmCacheBody,
  ClientRegistration,
  ClientStore,
  DcrRateLimitStore,
  JsonWebKeySet,
  JwksCache,
  JwksCacheEntry,
} from './stores';

const log = logging('mcp-auth:dbStores');

export type McpDataServiceOpts = {
  baseUrl?: string;
  apiKey?: string;
};

type Resolved = { baseUrl: string; apiKey: string };

const resolveOpts = (opts?: McpDataServiceOpts): Resolved => {
  const baseUrl = (
    opts?.baseUrl ??
    config.configString('mcpDataService:url', 'http://mcp-data-service:3000')
  )
    .trim()
    .replace(/\/+$/, '');
  const apiKey = (
    opts?.apiKey ?? config.configString('mcpDataService:apiKey', '')
  ).trim();
  if (baseUrl === '') {
    throw new Error(
      'mcp-data-service: baseUrl is empty; set "mcpDataService:url" in config.',
    );
  }
  return { baseUrl, apiKey };
};

const buildUrl = (baseUrl: string, pathAndQuery: string): string => {
  const pq = pathAndQuery.startsWith('/') ? pathAndQuery : `/${pathAndQuery}`;
  return `${baseUrl}${pq}`;
};

type FetchOpts = { method?: string; body?: unknown };

const dataFetch = async (
  resolved: Resolved,
  pathAndQuery: string,
  opts: FetchOpts = {},
): Promise<Response> => {
  const method = opts.method ?? 'GET';
  const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  const headers: Record<string, string> = { 'X-Api-Key': resolved.apiKey };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(buildUrl(resolved.baseUrl, pathAndQuery), {
    method,
    headers,
    body,
  });
};

const formatError = async (
  response: Response,
  url: string,
): Promise<string> => {
  const text = await response.text();
  const trimmed = text.length > 500 ? `${text.slice(0, 500)}…` : text;
  return `mcp-data-service HTTP ${response.status} for ${url}: ${trimmed}`;
};

// ─── ClientStore ────────────────────────────────────────────────────────────

type RawMcpClient = {
  client_id: string;
  client_id_issued_at: number;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
};

const rawToRegistration = (raw: RawMcpClient): ClientRegistration => ({
  client_id: raw.client_id,
  client_id_issued_at: Number(raw.client_id_issued_at),
  redirect_uris: raw.redirect_uris,
  grant_types: raw.grant_types,
  response_types: raw.response_types,
  token_endpoint_auth_method: raw.token_endpoint_auth_method,
});

export const createDbClientStore = (opts?: McpDataServiceOpts): ClientStore => {
  const resolved = resolveOpts(opts);
  return {
    get: async (id) => {
      const path = `/api/mcpClient/${encodeURIComponent(id)}`;
      const response = await dataFetch(resolved, path);
      if (response.status === 204 || response.status === 404) return undefined;
      if (!response.ok) {
        const msg = await formatError(
          response,
          buildUrl(resolved.baseUrl, path),
        );
        log.error(msg);
        throw new Error(msg);
      }
      const raw = (await response.json()) as RawMcpClient;
      return rawToRegistration(raw);
    },
    set: async (id, reg) => {
      const path = `/api/mcpClient/${encodeURIComponent(id)}`;
      const response = await dataFetch(resolved, path, {
        method: 'PUT',
        body: {
          client_id_issued_at: reg.client_id_issued_at,
          redirect_uris: reg.redirect_uris,
          grant_types: reg.grant_types,
          response_types: reg.response_types,
          token_endpoint_auth_method: reg.token_endpoint_auth_method,
        },
      });
      if (!response.ok) {
        const msg = await formatError(
          response,
          buildUrl(resolved.baseUrl, path),
        );
        log.error(msg);
        throw new Error(msg);
      }
    },
  };
};

// ─── DcrRateLimitStore ──────────────────────────────────────────────────────

export const createDbDcrRateLimitStore = (
  opts?: McpDataServiceOpts,
): DcrRateLimitStore => {
  const resolved = resolveOpts(opts);
  return {
    recordAndCheck: async (ip, windowMs, max) => {
      const path = '/api/mcpDcrAttempt/recordAndCheck';
      const response = await dataFetch(resolved, path, {
        method: 'POST',
        body: { ip, windowMs, max },
      });
      if (!response.ok) {
        const msg = await formatError(
          response,
          buildUrl(resolved.baseUrl, path),
        );
        log.error(msg);
        throw new Error(msg);
      }
      const body = (await response.json()) as { allowed: boolean };
      return Boolean(body.allowed);
    },
  };
};

// ─── JwksCache ──────────────────────────────────────────────────────────────

type RawJwksCacheEntry = {
  auth_server_url: string;
  jwks_uri: string;
  jwks_document: JsonWebKeySet;
  fetched_at: string;
};

export const createDbJwksCache = (opts?: McpDataServiceOpts): JwksCache => {
  const resolved = resolveOpts(opts);
  return {
    get: async (authServerUrl): Promise<JwksCacheEntry | undefined> => {
      const path = `/api/mcpJwksCache/byAuthServer?authServerUrl=${encodeURIComponent(
        authServerUrl,
      )}`;
      const response = await dataFetch(resolved, path);
      if (response.status === 204 || response.status === 404) return undefined;
      if (!response.ok) {
        const msg = await formatError(
          response,
          buildUrl(resolved.baseUrl, path),
        );
        log.error(msg);
        throw new Error(msg);
      }
      const raw = (await response.json()) as RawJwksCacheEntry;
      return { jwksUri: raw.jwks_uri, jwks: raw.jwks_document };
    },
    set: async (authServerUrl, jwksUri, jwks) => {
      const path = '/api/mcpJwksCache/byAuthServer';
      const response = await dataFetch(resolved, path, {
        method: 'PUT',
        body: {
          auth_server_url: authServerUrl,
          jwks_uri: jwksUri,
          jwks_document: jwks,
        },
      });
      if (!response.ok) {
        const msg = await formatError(
          response,
          buildUrl(resolved.baseUrl, path),
        );
        log.error(msg);
        throw new Error(msg);
      }
    },
  };
};

// ─── AsmCache ───────────────────────────────────────────────────────────────

type RawAsmCacheEntry = {
  asm_uri: string;
  body: AsmCacheBody;
  fetched_at: string;
};

export const createDbAsmCache = (opts?: McpDataServiceOpts): AsmCache => {
  const resolved = resolveOpts(opts);
  return {
    get: async (asmUri, ttlMs) => {
      const path = `/api/mcpAsmCache/byUri?asmUri=${encodeURIComponent(
        asmUri,
      )}&ttlMs=${ttlMs}`;
      const response = await dataFetch(resolved, path);
      if (response.status === 204 || response.status === 404) return undefined;
      if (!response.ok) {
        const msg = await formatError(
          response,
          buildUrl(resolved.baseUrl, path),
        );
        log.error(msg);
        throw new Error(msg);
      }
      const raw = (await response.json()) as RawAsmCacheEntry;
      return raw.body;
    },
    set: async (asmUri, body) => {
      const path = '/api/mcpAsmCache/byUri';
      const response = await dataFetch(resolved, path, {
        method: 'PUT',
        body: { asm_uri: asmUri, body },
      });
      if (!response.ok) {
        const msg = await formatError(
          response,
          buildUrl(resolved.baseUrl, path),
        );
        log.error(msg);
        throw new Error(msg);
      }
    },
  };
};
