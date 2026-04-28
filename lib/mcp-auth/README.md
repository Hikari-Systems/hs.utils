# MCP OAuth 2.1 Auth Middleware

Self-contained OAuth 2.1 resource-server layer for the bioalphaengine MCP
server. Lives entirely under `lib/auth/` so the layer can be lifted out
and wrapped around any other Express-based MCP server unchanged.

## 1. Architecture

This server is **only** an OAuth 2.1 resource server. It never mints
access tokens or refresh tokens. Token issuance is delegated entirely to
an external Authorization Server (AS) — by default
`https://sso.hikari-systems.com`, configurable via
`oauth2:authorizationServer`.

There are no cookies and no server-side sessions. Every request is
verified statelessly against the AS's published JWKS.

## 2. Discovery flow

A client connecting for the first time:

1. `GET /.well-known/oauth-protected-resource` — RFC 9728 PRM. Returns
   the canonical resource URL, the AS to talk to, and the scopes this
   server understands.
2. `GET /.well-known/oauth-authorization-server` — RFC 8414 ASM. We
   proxy the AS's own metadata, sanitised against the RFC 8414 §2 field
   allowlist and cached for 5 minutes.
3. PKCE `S256` authorization code flow against the AS's
   `authorization_endpoint` and `token_endpoint`.
4. `Authorization: Bearer <jwt>` on every request to `/mcp`. The
   middleware verifies signature, `iss`, `aud`, `exp`, `nbf` (with a
   configurable clock-skew tolerance, default 30s).

## 3. CIMD vs DCR

For new clients prefer **Client ID Metadata Document** (the MCP 2025-11-25
default). A client publishes its metadata at a URL it controls; this
server stores known clients at
`/.well-known/client-metadata/:client_id`.

**Dynamic Client Registration** (RFC 7591, `POST /register`) is only
mounted when `mcp:auth:enableDcr=true` and is intended for backwards
compatibility with older OAuth clients. It is unauthenticated by design,
rate-limited per IP (5 / 60s sliding window), and rejects non-`https://`
redirect URIs except for `http://localhost` and `http://127.0.0.1`.

## 4. Lifting it out

To wrap a different Express MCP server with this layer:

1. Copy `lib/auth/` and the relevant test files.
2. `import { applyMcpAuth, loadAuthConfig } from './auth';` in the
   server entrypoint and call `applyMcpAuth(app, loadAuthConfig())`
   **before** mounting the MCP routes.
3. Set the required config keys (env via nconf `__` separator):
   - `mcp:auth:resourceServerUrl`
   - `mcp:auth:expectedAudience`
   - `mcp:auth:supportedScopes`
   - `oauth2:authorizationServer`

The only external coupling is `@hikari-systems/hs.utils` for config and
logging — drop it in to any sibling project that already uses hs.utils.

## 5. Known TODOs

- **Persistent client store.** `createClientStore()` is in-memory. Move
  to Postgres / oauth2-data-service before production.
- **Refresh token handling.** Out of scope for the resource server; the
  client refreshes against the AS directly.
- **Step-up auth (403 path).** The current middleware emits 401 for all
  failures. A future revision can return 403 with
  `WWW-Authenticate: Bearer error="insufficient_scope"` when a valid
  token lacks a required scope.
- **`trust proxy` for DCR rate limiting.** The bare Express app does not
  enable `trust proxy`, so `req.ip` is the immediate socket peer. When
  this server runs behind a load balancer the rate limit will collapse
  to a single bucket. Enable `app.set('trust proxy', ...)` in
  `lib/server.ts` once the deployment topology is known.
