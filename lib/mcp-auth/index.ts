import express from 'express';
import './types';
import { AuthConfig } from './config';
import {
  handleAuthServerMetadata,
  handleProtectedResourceMetadata,
  normalizeResourcePath,
} from './discovery';
import { createMcpAuthMiddleware } from './middleware';
import { createDcrHandler } from './dcr';
import { createCimdHandler } from './cimd';
import { AsmCache, ClientStore, DcrRateLimitStore, JwksCache } from './stores';
import {
  createDbAsmCache,
  createDbClientStore,
  createDbDcrRateLimitStore,
  createDbJwksCache,
} from './dbStores';

export type { AuthConfig } from './config';
export { loadAuthConfig } from './config';
export {
  handleProtectedResourceMetadata,
  handleAuthServerMetadata,
  normalizeResourcePath,
} from './discovery';
export { createTokenVerifier, TokenVerificationError } from './tokenVerifier';
export type { VerificationReason } from './tokenVerifier';
export { createMcpAuthMiddleware } from './middleware';
export { createDcrHandler } from './dcr';
export { createCimdHandler } from './cimd';

export type {
  AsmCache,
  AsmCacheBody,
  ClientRegistration,
  ClientStore,
  DcrRateLimitStore,
  JsonWebKeySet,
  JwksCache,
  JwksCacheEntry,
} from './stores';
export {
  createAsmCache,
  createClientStore,
  createDcrRateLimitStore,
  createJwksCache,
} from './stores';

export type { McpDataServiceOpts } from './dbStores';
export {
  createDbAsmCache,
  createDbClientStore,
  createDbDcrRateLimitStore,
  createDbJwksCache,
} from './dbStores';

export type McpAuthStores = {
  clients?: ClientStore;
  rateLimit?: DcrRateLimitStore;
  jwks?: JwksCache;
  asm?: AsmCache;
};

export type McpAuthOptions = McpAuthStores & {
  // Sub-path the protected resource is mounted at (e.g. '/mcp'). Used to
  // register the RFC 9728 path-suffix PRM URL and to advertise the correct
  // `resource` and `resource_metadata` values. Defaults to '' (host root).
  resourcePath?: string;
};

export const applyMcpAuth = (
  app: express.IRouter,
  config: AuthConfig,
  options: McpAuthOptions = {},
): void => {
  const clients = options.clients ?? createDbClientStore();
  const rateLimit = options.rateLimit ?? createDbDcrRateLimitStore();
  const jwks = options.jwks ?? createDbJwksCache();
  const asm = options.asm ?? createDbAsmCache();
  const resourcePath = normalizeResourcePath(options.resourcePath);

  // Bare path serves the host-root PRM; the path-suffix variant is required
  // by RFC 9728 when the resource is at a sub-path. Register both so legacy
  // clients hitting the bare path still get a useful response.
  app.get(
    '/.well-known/oauth-protected-resource',
    handleProtectedResourceMetadata(config, resourcePath),
  );
  if (resourcePath !== '') {
    app.get(
      `/.well-known/oauth-protected-resource${resourcePath}`,
      handleProtectedResourceMetadata(config, resourcePath),
    );
  }
  app.get(
    '/.well-known/oauth-authorization-server',
    handleAuthServerMetadata(config, asm),
  );
  app.get(
    '/.well-known/client-metadata/:client_id',
    createCimdHandler(clients),
  );

  if (config.enableDcr) {
    app.post(
      '/register',
      express.json(),
      createDcrHandler(config, clients, rateLimit),
    );
  }

  app.use(createMcpAuthMiddleware(config, jwks, resourcePath));
};
