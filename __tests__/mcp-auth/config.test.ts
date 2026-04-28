// hs.utils config is built on nconf, which snapshots process.env at .env()
// call time. To get a fresh snapshot per test we wrap each require inside
// jest.isolateModules — that resets the entire module chain (including nconf
// and hs.utils) so the new env values take effect.

const REQUIRED_ENV_KEYS = [
  'mcp__auth__resourceServerUrl',
  'mcp__auth__expectedAudience',
  'mcp__auth__supportedScopes',
  'mcp__auth__enableDcr',
  'mcp__auth__jwksUri',
  'mcp__auth__clockSkewSeconds',
  'oauth2__authorizationServer',
];

const clearAuthEnv = (): void => {
  for (const k of REQUIRED_ENV_KEYS) delete process.env[k];
};

const importConfig = (): typeof import('../../lib/mcp-auth/config') => {
  let mod: typeof import('../../lib/mcp-auth/config') | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('../../lib/mcp-auth/config');
  });
  if (!mod) throw new Error('isolateModules failed to load config module');
  return mod;
};

describe('loadAuthConfig', () => {
  beforeEach(() => {
    clearAuthEnv();
  });

  afterAll(() => {
    clearAuthEnv();
  });

  it('throws when mcp:auth:resourceServerUrl is missing', () => {
    process.env.mcp__auth__expectedAudience = 'https://aud.example';
    process.env.mcp__auth__supportedScopes = 'mcp:read';
    const { loadAuthConfig } = importConfig();
    expect(() => loadAuthConfig()).toThrow(/resourceServerUrl/);
  });

  it('throws when supportedScopes is missing', () => {
    process.env.mcp__auth__resourceServerUrl = 'https://rs.example';
    process.env.mcp__auth__expectedAudience = 'https://rs.example';
    const { loadAuthConfig } = importConfig();
    expect(() => loadAuthConfig()).toThrow(/supportedScopes/);
  });

  it('parses comma-separated scopes, trimming whitespace', () => {
    process.env.mcp__auth__resourceServerUrl = 'https://rs.example';
    process.env.mcp__auth__expectedAudience = 'https://rs.example';
    process.env.mcp__auth__supportedScopes = ' mcp:read , mcp:write , ';
    const { loadAuthConfig } = importConfig();
    const cfg = loadAuthConfig();
    expect(cfg.supportedScopes).toEqual(['mcp:read', 'mcp:write']);
  });

  it('defaults clockSkewSeconds to 30 and enableDcr to false', () => {
    process.env.mcp__auth__resourceServerUrl = 'https://rs.example';
    process.env.mcp__auth__expectedAudience = 'https://rs.example';
    process.env.mcp__auth__supportedScopes = 'mcp:read';
    const { loadAuthConfig } = importConfig();
    const cfg = loadAuthConfig();
    expect(cfg.clockSkewSeconds).toBe(30);
    expect(cfg.enableDcr).toBe(false);
  });

  it('reads enableDcr=true and a non-default authorizationServerUrl', () => {
    process.env.mcp__auth__resourceServerUrl = 'https://rs.example';
    process.env.mcp__auth__expectedAudience = 'https://rs.example';
    process.env.mcp__auth__supportedScopes = 'mcp:read';
    process.env.mcp__auth__enableDcr = 'true';
    process.env.oauth2__authorizationServer = 'https://as.example';
    const { loadAuthConfig } = importConfig();
    const cfg = loadAuthConfig();
    expect(cfg.enableDcr).toBe(true);
    expect(cfg.authorizationServerUrl).toBe('https://as.example');
  });

  it('leaves jwksUri undefined when not configured', () => {
    process.env.mcp__auth__resourceServerUrl = 'https://rs.example';
    process.env.mcp__auth__expectedAudience = 'https://rs.example';
    process.env.mcp__auth__supportedScopes = 'mcp:read';
    const { loadAuthConfig } = importConfig();
    const cfg = loadAuthConfig();
    expect(cfg.jwksUri).toBeUndefined();
  });
});
