import { RequestHandler } from 'express';
import { AuthConfig } from './config';
import { createTokenVerifier, TokenVerificationError } from './tokenVerifier';

const buildWwwAuthenticate = (config: AuthConfig): string =>
  `Bearer realm="${config.resourceServerUrl}", ` +
  `resource_metadata="${config.resourceServerUrl}/.well-known/oauth-protected-resource"`;

export const createMcpAuthMiddleware = (config: AuthConfig): RequestHandler => {
  const verify = createTokenVerifier(config);
  const wwwAuth = buildWwwAuthenticate(config);

  return async (req, res, next) => {
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
