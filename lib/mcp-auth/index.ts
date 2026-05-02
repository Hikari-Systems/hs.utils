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
import type { PostLoginAction } from '../postLoginActions';
import type { McpUserResolver } from './userResolution';

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

export type { McpAuthInfo } from './types';
export type { McpDataServiceOpts } from './dbStores';
export type {
  McpResolvedUser,
  McpUserResolver,
  McpUserResolutionOptions,
} from './userResolution';
export { createOidcUserResolver } from './userResolution';
export {
  createDbAsmCache,
  createDbClientStore,
  createDbDcrRateLimitStore,
  createDbJwksCache,
} from './dbStores';
export type { HydraClientStoreOpts } from './hydraClientStore';
export { createHydraClientStore } from './hydraClientStore';
export type { KratosResolverOpts } from './kratosResolver';
export { createKratosUserResolver } from './kratosResolver';

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
  // Optional. After token verification, look up / create the local user
  // record by hitting the IdP's /userinfo endpoint and upserting via
  // consumer-supplied callbacks. The resolved {userId, profile} is merged
  // into req.auth.extra so MCP tool handlers see it as
  // `extra.authInfo.extra.userId` / `extra.authInfo.extra.profile`. Use
  // `createOidcUserResolver` for the standard impl.
  userResolver?: McpUserResolver;
  // Optional. Side-effects to run after each successful user resolution:
  // image uploads, audit logs, role provisioning, welcome emails, etc.
  // Actions run in parallel; errors are logged and swallowed so a failing
  // action can't break the request. Action implementations should
  // self-deduplicate (e.g. via an in-process Set) since they will run on
  // every authenticated request unless they short-circuit.
  postLoginActions?: PostLoginAction[];
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

  app.use(
    createMcpAuthMiddleware(
      config,
      jwks,
      resourcePath,
      options.userResolver,
      options.postLoginActions,
    ),
  );
};
