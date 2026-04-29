import { RequestHandler } from 'express';
import logging from '../logging';
import { forwardedFor } from '../forwardedFor';
import { AuthConfig } from './config';
import { AsmCache, createAsmCache } from './stores';

// Normalize a resource sub-path to the form '' or '/foo' (no trailing slash).
// '' represents a resource at the host root.
export const normalizeResourcePath = (raw: string | undefined): string => {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '/') return '';
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeading.replace(/\/+$/, '');
};

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

const sanitizeAsm = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, unknown> = {};
  Object.entries(raw as Record<string, unknown>).forEach(([k, v]) => {
    if (ASM_FIELD_ALLOWLIST.has(k)) out[k] = v;
  });
  return out;
};

// RFC 9728 PRM. The `resource` field is derived from the inbound request's
// forwarded host so discovery works behind reverse proxies and tunnels
// (ngrok, cloud LBs, etc.) without rewriting config. `resourcePath` is the
// sub-path the protected resource is mounted at (e.g. '/mcp'); pass '' when
// the resource is the host root.
export const handleProtectedResourceMetadata =
  (config: AuthConfig, resourcePath: string = ''): RequestHandler =>
  (req, res) => {
    const path = normalizeResourcePath(resourcePath);
    const { baseUrl } = forwardedFor(req);
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json({
      resource: `${baseUrl}${path}`,
      authorization_servers: [config.authorizationServerUrl],
      scopes_supported: config.supportedScopes,
      bearer_methods_supported: ['header'],
    });
  };

export const handleAuthServerMetadata =
  (config: AuthConfig, cache: AsmCache = createAsmCache()): RequestHandler =>
  async (_req, res) => {
    const upstream = `${config.authorizationServerUrl.replace(
      /\/+$/,
      '',
    )}/.well-known/oauth-authorization-server`;

    const cached = await cache.get(upstream, ASM_CACHE_TTL_MS);
    if (cached) {
      res.setHeader('Content-Type', 'application/json');
      res.status(200).json(cached);
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

    await cache.set(upstream, sanitized);

    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(sanitized);
  };
