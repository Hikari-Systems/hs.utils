import express from 'express';
import './types';
import { AuthConfig } from './config';
import {
  handleAuthServerMetadata,
  handleProtectedResourceMetadata,
} from './discovery';
import { createMcpAuthMiddleware } from './middleware';
import { createClientStore, createDcrHandler } from './dcr';
import { createCimdHandler } from './cimd';

export type { AuthConfig } from './config';
export { loadAuthConfig } from './config';
export {
  handleProtectedResourceMetadata,
  handleAuthServerMetadata,
  asmCache,
} from './discovery';
export {
  createTokenVerifier,
  TokenVerificationError,
  resetVerifierCachesForTests,
} from './tokenVerifier';
export type { VerificationReason } from './tokenVerifier';
export { createMcpAuthMiddleware } from './middleware';
export {
  createClientStore,
  createDcrHandler,
  dcrRateLimit,
  resetDcrRateLimitForTests,
} from './dcr';
export type { ClientRegistration, ClientStore } from './dcr';
export { createCimdHandler } from './cimd';

export const applyMcpAuth = (
  app: express.Application,
  config: AuthConfig,
): void => {
  const store = createClientStore();

  app.get(
    '/.well-known/oauth-protected-resource',
    handleProtectedResourceMetadata(config),
  );
  app.get(
    '/.well-known/oauth-authorization-server',
    handleAuthServerMetadata(config),
  );
  app.get('/.well-known/client-metadata/:client_id', createCimdHandler(store));

  if (config.enableDcr) {
    app.post('/register', express.json(), createDcrHandler(config, store));
  }

  app.use(createMcpAuthMiddleware(config));
};
