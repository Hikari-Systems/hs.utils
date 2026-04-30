import { Request, RequestHandler } from 'express';
import type { JWTPayload } from 'jose';
import { forwardedFor } from '../forwardedFor';
import { AuthConfig } from './config';
import { normalizeResourcePath } from './discovery';
import { createTokenVerifier, TokenVerificationError } from './tokenVerifier';
import { JwksCache, createJwksCache } from './stores';
import type { McpAuthInfo } from './types';
import type { McpUserResolver } from './userResolution';

const buildWwwAuthenticate = (req: Request, resourcePath: string): string => {
  const { baseUrl } = forwardedFor(req);
  return (
    `Bearer realm="${baseUrl}${resourcePath}", ` +
    `resource_metadata="${baseUrl}/.well-known/oauth-protected-resource${resourcePath}"`
  );
};

// Map a verified JWT payload + raw token to the MCP SDK's AuthInfo shape.
// This is what tool handlers receive as `extra.authInfo`.
const buildAuthInfo = (token: string, payload: JWTPayload): McpAuthInfo => {
  const scopeClaim = (payload as { scope?: unknown }).scope;
  const scopes =
    typeof scopeClaim === 'string'
      ? scopeClaim.split(/\s+/).filter((s) => s.length > 0)
      : Array.isArray(scopeClaim)
        ? scopeClaim.filter((s): s is string => typeof s === 'string')
        : [];

  // `clientId` in the SDK is the OAuth client that obtained the token. For
  // Auth0-issued tokens that's the `azp` claim; fall back to client_id then
  // sub then '' so the field is always present.
  const azp = (payload as { azp?: unknown }).azp;
  const clientIdClaim = (payload as { client_id?: unknown }).client_id;
  const clientId =
    typeof azp === 'string'
      ? azp
      : typeof clientIdClaim === 'string'
        ? clientIdClaim
        : typeof payload.sub === 'string'
          ? payload.sub
          : '';

  // `aud` may be a string or string[]. If it parses as a URL, surface it.
  let resource: URL | undefined;
  const audCandidate = Array.isArray(payload.aud)
    ? payload.aud[0]
    : payload.aud;
  if (typeof audCandidate === 'string') {
    try {
      resource = new URL(audCandidate);
    } catch {
      resource = undefined;
    }
  }

  return {
    token,
    clientId,
    scopes,
    expiresAt: typeof payload.exp === 'number' ? payload.exp : undefined,
    resource,
    extra: payload as Record<string, unknown>,
  };
};

export const createMcpAuthMiddleware = (
  config: AuthConfig,
  jwks: JwksCache = createJwksCache(),
  resourcePath: string = '',
  resolveUser?: McpUserResolver,
): RequestHandler => {
  const verify = createTokenVerifier(config, jwks);
  const path = normalizeResourcePath(resourcePath);

  return async (req, res, next) => {
    const wwwAuth = buildWwwAuthenticate(req, path);
    if (req.path.startsWith('/.well-known/')) {
      next();
      return;
    }
    if (req.method === 'POST' && req.path === '/register') {
      next();
      return;
    }

    const header = req.header('authorization') ?? req.header('Authorization');
    if (!header) {
      res.setHeader('WWW-Authenticate', wwwAuth);
      res.setHeader('Content-Type', 'application/json');
      res.status(401).json({
        error: 'invalid_token',
        error_description: 'Missing or malformed Authorization header',
      });
      return;
    }
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) {
      res.setHeader('WWW-Authenticate', wwwAuth);
      res.setHeader('Content-Type', 'application/json');
      res.status(401).json({
        error: 'invalid_token',
        error_description: 'Missing or malformed Authorization header',
      });
      return;
    }
    const token = match[1].trim();

    try {
      const payload = await verify(token);
      req.mcpAuthToken = payload;
      // Also expose as the MCP SDK's `req.auth` so tool handlers receive
      // `extra.authInfo` populated by StreamableHTTPServerTransport.
      req.auth = buildAuthInfo(token, payload);

      if (resolveUser) {
        const resolved = await resolveUser(token, payload);
        if (resolved) {
          req.auth.extra = {
            ...req.auth.extra,
            userId: resolved.userId,
            profile: resolved.profile,
          };
        }
      }
      next();
    } catch (err) {
      const reason =
        err instanceof TokenVerificationError ? err.reason : 'unknown';
      res.setHeader('WWW-Authenticate', wwwAuth);
      res.setHeader('Content-Type', 'application/json');
      const body: { error: string; error_description?: string } = {
        error: 'invalid_token',
      };
      if (reason === 'expired') body.error_description = 'Token has expired';
      else if (reason === 'wrong_audience')
        body.error_description = 'Token audience mismatch';
      res.status(401).json(body);
    }
  };
};
