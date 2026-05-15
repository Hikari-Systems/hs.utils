import type { JWTPayload } from 'jose';

// Structurally compatible with @modelcontextprotocol/sdk's AuthInfo. We
// don't take a hard dependency on the SDK; we just shape `req.auth` so the
// SDK's StreamableHTTPServerTransport (which reads `req.auth`) can pass it
// through to tool handlers as `extra.authInfo`.
export type McpAuthInfo = {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt?: number;
  resource?: URL;
  extra?: Record<string, unknown>;
};

declare module 'express-serve-static-core' {
  interface Request {
    mcpAuthToken?: JWTPayload;
    auth?: McpAuthInfo;
  }
}

export {};
