import config from '../config';

export type AuthConfig = {
  resourceServerUrl: string;
  authorizationServerUrl: string;
  supportedScopes: string[];
  expectedAudience: string;
  enableDcr: boolean;
  jwksUri?: string;
  clockSkewSeconds: number;
  // Optional admin URLs for self-hosted Ory stack. When present, MCP servers
  // can use createHydraClientStore (CIMD lookup) and createKratosUserResolver
  // (identity lookup) instead of the legacy mcp-data-service / UDS path.
  // Empty string when not configured.
  hydraAdminUrl?: string;
  kratosAdminUrl?: string;
  // Custom claims namespace prefix. Used by createKratosUserResolver to read
  // email/name/picture from JWT payload. Defaults to
  // 'https://hikari-systems.com/'.
  claimsNamespace?: string;
  // Audience allowlist used by the Hydra DCR proxy when registering a new
  // client: the set of resource URLs the registered client is permitted to
  // request via the `audience` parameter at /oauth2/auth (or /oauth2/token).
  // Hydra's RFC 8707 `resource` parameter is unimplemented in v2.x; the Ory
  // `audience` parameter is the actual mechanism. Per-token aud is narrowed
  // to whatever the client requests from this list. Empty when the service
  // does not host the proxy. Parsed from comma-separated string.
  allowedAudiences: string[];
};

const requiredString = (key: string): string => {
  const value = config.configString(key, '');
  if (value === '') {
    throw new Error(
      `MCP auth config: required key "${key}" is missing or empty. ` +
        `Set it in config.json or via env var "${key.replace(/:/g, '__')}".`,
    );
  }
  return value;
};

const parseScopes = (raw: string): string[] => {
  const scopes = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (scopes.length === 0) {
    throw new Error(
      'MCP auth config: "mcp:auth:supportedScopes" must contain at least ' +
        'one comma-separated scope.',
    );
  }
  return scopes;
};

const parseCsv = (raw: string): string[] =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

export const loadAuthConfig = (): AuthConfig => {
  const resourceServerUrl = requiredString('mcp:auth:resourceServerUrl');
  const expectedAudience = requiredString('mcp:auth:expectedAudience');
  const supportedScopes = parseScopes(
    requiredString('mcp:auth:supportedScopes'),
  );
  const authorizationServerUrl = config.configString(
    'oauth2:authorizationServer',
    'https://sso.hikari-systems.com',
  );
  const enableDcr = config.configBoolean('mcp:auth:enableDcr', false);
  const clockSkewSeconds = config.configInteger(
    'mcp:auth:clockSkewSeconds',
    30,
  );
  const jwksUriRaw = config.configString('mcp:auth:jwksUri', '');
  const jwksUri = jwksUriRaw === '' ? undefined : jwksUriRaw;
  const hydraAdminUrlRaw = config.configString('hydra:adminUrl', '');
  const hydraAdminUrl = hydraAdminUrlRaw === '' ? undefined : hydraAdminUrlRaw;
  const kratosAdminUrlRaw = config.configString('kratos:adminUrl', '');
  const kratosAdminUrl =
    kratosAdminUrlRaw === '' ? undefined : kratosAdminUrlRaw;
  const claimsNamespaceRaw = config.configString(
    'mcp:auth:claimsNamespace',
    '',
  );
  const claimsNamespace =
    claimsNamespaceRaw === '' ? undefined : claimsNamespaceRaw;
  const allowedAudiences = parseCsv(
    config.configString('mcp:auth:allowedAudiences', ''),
  );

  return {
    resourceServerUrl,
    authorizationServerUrl,
    supportedScopes,
    expectedAudience,
    enableDcr,
    jwksUri,
    clockSkewSeconds,
    hydraAdminUrl,
    kratosAdminUrl,
    claimsNamespace,
    allowedAudiences,
  };
};
