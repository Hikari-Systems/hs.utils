import express, { RequestHandler } from 'express';
import logging from '../logging';

const log = logging('mcp-auth:hydraDcrProxy');

// Minimal config the DCR proxy needs. Kept narrow so callers that aren't
// MCP servers themselves (e.g. hs-login-controller hosting the proxy) don't
// have to fabricate MCP-specific fields like expectedAudience.
export type HydraDcrProxyConfig = {
  authorizationServerUrl: string;
  allowedAudiences: string[];
};

const jsonError = (
  res: express.Response,
  status: number,
  error: string,
  description?: string,
): void => {
  res.setHeader('Content-Type', 'application/json');
  res
    .status(status)
    .json(
      description === undefined
        ? { error }
        : { error, error_description: description },
    );
};

// DCR proxy that forwards RFC 7591 client registration to Hydra's
// /oauth2/register, but injects `audience: config.allowedAudiences` so the
// resulting client is permitted to request any of those audiences via the
// `audience` parameter at /oauth2/auth. Hydra v2 ignores RFC 8707's
// `resource` parameter; the Ory `audience` parameter is the actual mechanism
// that flows through to the access token's `aud` claim. Per-token scoping
// happens at auth time (Apache rewrites resource→audience there).
export const createHydraDcrProxyHandler = (
  config: HydraDcrProxyConfig,
): RequestHandler => {
  if (config.allowedAudiences.length === 0) {
    throw new Error(
      'createHydraDcrProxyHandler: config.allowedAudiences must be non-empty. ' +
        'Set "mcp:auth:allowedAudiences" to a comma-separated list of MCP ' +
        'resource URLs the proxy is allowed to register clients for.',
    );
  }
  const upstream = `${config.authorizationServerUrl.replace(
    /\/+$/,
    '',
  )}/oauth2/register`;

  return async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body !== 'object' || Array.isArray(body)) {
      jsonError(
        res,
        400,
        'invalid_client_metadata',
        'Request body must be a JSON object.',
      );
      return;
    }
    const incomingAudience = Array.isArray(body.audience)
      ? body.audience.filter((a): a is string => typeof a === 'string')
      : [];
    // Union the client's request with the configured allowlist. The set of
    // audiences a client may *request* on auth is what matters here; per-token
    // narrowing happens via the audience param at /oauth2/auth.
    const audience = Array.from(
      new Set([...incomingAudience, ...config.allowedAudiences]),
    );

    let upstreamResp: Response;
    try {
      upstreamResp = await fetch(upstream, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, audience }),
      });
    } catch (err) {
      log.error(
        `DCR proxy upstream fetch to ${upstream} failed: ${
          (err as Error).message
        }`,
      );
      jsonError(
        res,
        502,
        'upstream_unavailable',
        'Failed to reach upstream authorization server.',
      );
      return;
    }

    const text = await upstreamResp.text();
    res.status(upstreamResp.status);
    const ct = upstreamResp.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);
    res.send(text);
  };
};
