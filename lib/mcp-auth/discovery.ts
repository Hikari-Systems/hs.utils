import { RequestHandler } from 'express';
import logging from '../logging';
import { AuthConfig } from './config';

const log = logging('mcp-auth');

const ASM_FIELD_ALLOWLIST = new Set<string>([
  'issuer',
  'authorization_endpoint',
  'token_endpoint',
  'jwks_uri',
  'registration_endpoint',
  'scopes_supported',
  'response_types_supported',
  'response_modes_supported',
  'grant_types_supported',
  'token_endpoint_auth_methods_supported',
  'token_endpoint_auth_signing_alg_values_supported',
  'service_documentation',
  'ui_locales_supported',
  'op_policy_uri',
  'op_tos_uri',
  'revocation_endpoint',
  'revocation_endpoint_auth_methods_supported',
  'introspection_endpoint',
  'introspection_endpoint_auth_methods_supported',
  'code_challenge_methods_supported',
]);

const ASM_CACHE_TTL_MS = 5 * 60 * 1000;

type AsmCacheEntry = { fetchedAt: number; body: Record<string, unknown> };

export const asmCache = new Map<string, AsmCacheEntry>();

const sanitizeAsm = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, unknown> = {};
  Object.entries(raw as Record<string, unknown>).forEach(([k, v]) => {
    if (ASM_FIELD_ALLOWLIST.has(k)) out[k] = v;
  });
  return out;
};

export const handleProtectedResourceMetadata =
  (config: AuthConfig): RequestHandler =>
  (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json({
      resource: config.resourceServerUrl,
      authorization_servers: [config.authorizationServerUrl],
      scopes_supported: config.supportedScopes,
      bearer_methods_supported: ['header'],
    });
  };

export const handleAuthServerMetadata =
  (config: AuthConfig): RequestHandler =>
  async (_req, res) => {
    const upstream = `${config.authorizationServerUrl.replace(
      /\/+$/,
      '',
    )}/.well-known/oauth-authorization-server`;

    const cached = asmCache.get(upstream);
    if (cached && Date.now() - cached.fetchedAt < ASM_CACHE_TTL_MS) {
      res.setHeader('Content-Type', 'application/json');
      res.status(200).json(cached.body);
      return;
    }

    let upstreamBody: unknown;
    try {
      const response = await fetch(upstream, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`upstream HTTP ${response.status}`);
      }
      upstreamBody = await response.json();
    } catch (err) {
      log.warn(
        `ASM proxy: upstream fetch failed for ${upstream}: ${
          (err as Error).message
        }`,
      );
      res.setHeader('Content-Type', 'application/json');
      res.status(502).json({
        error: 'upstream_unavailable',
        error_description:
          'Could not fetch authorization server metadata from upstream.',
      });
      return;
    }

    const sanitized = sanitizeAsm(upstreamBody);

    const pkceMethods = sanitized.code_challenge_methods_supported;
    const supportsS256 =
      Array.isArray(pkceMethods) && pkceMethods.includes('S256');
    if (!supportsS256) {
      log.warn(
        'ASM proxy: upstream does not advertise PKCE S256 in ' +
          'code_challenge_methods_supported. OAuth 2.1 requires S256.',
      );
    }

    asmCache.set(upstream, { fetchedAt: Date.now(), body: sanitized });

    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(sanitized);
  };
