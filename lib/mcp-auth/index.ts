import express from 'express';
import './types';
import { AuthConfig } from './config';
import {
  handleAuthServerMetadata,
  handleProtectedResourceMetadata,
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

export const applyMcpAuth = (
  app: express.IRouter,
  config: AuthConfig,
  stores: McpAuthStores = {},
): void => {
  const clients = stores.clients ?? createDbClientStore();
  const rateLimit = stores.rateLimit ?? createDbDcrRateLimitStore();
  const jwks = stores.jwks ?? createDbJwksCache();
  const asm = stores.asm ?? createDbAsmCache();

  app.get(
    '/.well-known/oauth-protected-resource',
    handleProtectedResourceMetadata(config),
  );
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

  app.use(createMcpAuthMiddleware(config, jwks));
};
