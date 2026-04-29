import express from 'express';
import request from 'supertest';
import {
  handleAuthServerMetadata,
  handleProtectedResourceMetadata,
} from '../../lib/mcp-auth/discovery';
import { createAsmCache } from '../../lib/mcp-auth/stores';
import { AuthConfig } from '../../lib/mcp-auth/config';

const baseConfig: AuthConfig = {
  resourceServerUrl: 'https://rs.example',
  authorizationServerUrl: 'https://as.example',
  supportedScopes: ['mcp:read', 'mcp:write'],
  expectedAudience: 'https://rs.example',
  enableDcr: false,
  clockSkewSeconds: 30,
};

describe('handleProtectedResourceMetadata', () => {
  it('returns the canonical PRM body shape', async () => {
    const app = express();
    app.get(
      '/.well-known/oauth-protected-resource',
      handleProtectedResourceMetadata(baseConfig),
    );
    const res = await request(app).get('/.well-known/oauth-protected-resource');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({
      resource: 'https://rs.example',
      authorization_servers: ['https://as.example'],
      scopes_supported: ['mcp:read', 'mcp:write'],
      bearer_methods_supported: ['header'],
    });
  });
});

describe('handleAuthServerMetadata', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('strips fields outside the RFC 8414 §2 allowlist', async () => {
    const upstreamBody = {
      issuer: 'https://as.example',
      authorization_endpoint: 'https://as.example/authorize',
      token_endpoint: 'https://as.example/token',
      jwks_uri: 'https://as.example/.well-known/jwks.json',
      code_challenge_methods_supported: ['S256'],
      // Unknown / hostile field that must be dropped.
      malicious_redirect: '; rm -rf /',
      vendor_specific: { evil: true },
    };
    globalThis.fetch = jest.fn(
      async () =>
        new Response(JSON.stringify(upstreamBody), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    const app = express();
    app.get(
      '/.well-known/oauth-authorization-server',
      handleAuthServerMetadata(baseConfig, createAsmCache()),
    );
    const res = await request(app).get(
      '/.well-known/oauth-authorization-server',
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('issuer', 'https://as.example');
    expect(res.body).toHaveProperty('authorization_endpoint');
    expect(res.body).toHaveProperty('code_challenge_methods_supported', [
      'S256',
    ]);
    expect(res.body).not.toHaveProperty('malicious_redirect');
    expect(res.body).not.toHaveProperty('vendor_specific');
  });

  it('caches the upstream response — second call does not refetch', async () => {
    const fetchMock = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            issuer: 'https://as.example',
            code_challenge_methods_supported: ['S256'],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const app = express();
    const cache = createAsmCache();
    app.get(
      '/.well-known/oauth-authorization-server',
      handleAuthServerMetadata(baseConfig, cache),
    );

    await request(app).get('/.well-known/oauth-authorization-server');
    await request(app).get('/.well-known/oauth-authorization-server');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns 502 when the upstream is unreachable', async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const app = express();
    app.get(
      '/.well-known/oauth-authorization-server',
      handleAuthServerMetadata(baseConfig, createAsmCache()),
    );
    const res = await request(app).get(
      '/.well-known/oauth-authorization-server',
    );

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('upstream_unavailable');
  });
});
