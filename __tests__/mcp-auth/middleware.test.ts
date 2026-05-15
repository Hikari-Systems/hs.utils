import http from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import request from 'supertest';
import { SignJWT, generateKeyPair, exportJWK, KeyLike, JWK } from 'jose';
import { createMcpAuthMiddleware } from '../../lib/mcp-auth/middleware';
import { createJwksCache } from '../../lib/mcp-auth/stores';
import { AuthConfig } from '../../lib/mcp-auth/config';

type Keys = { privateKey: KeyLike; publicJwk: JWK; kid: string };

const startJwksServer = (
  keys: Keys,
): Promise<{ url: string; close: () => Promise<void> }> =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/jwks.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            keys: [
              { ...keys.publicJwk, kid: keys.kid, alg: 'RS256', use: 'sig' },
            ],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/jwks.json`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });

const mintToken = async (
  keys: Keys,
  opts: {
    issuer: string;
    audience: string;
    expSecondsFromNow: number;
    sub?: string;
  },
): Promise<string> =>
  new SignJWT({ sub: opts.sub ?? 'user-1' })
    .setProtectedHeader({ alg: 'RS256', kid: keys.kid })
    .setIssuedAt()
    .setIssuer(opts.issuer)
    .setAudience(opts.audience)
    .setExpirationTime(Math.floor(Date.now() / 1000) + opts.expSecondsFromNow)
    .sign(keys.privateKey);

describe('createMcpAuthMiddleware', () => {
  let keys: Keys;
  let jwks: { url: string; close: () => Promise<void> };
  let config: AuthConfig;

  beforeAll(async () => {
    const kp = await generateKeyPair('RS256');
    const publicJwk = await exportJWK(kp.publicKey);
    keys = { privateKey: kp.privateKey, publicJwk, kid: 'test-kid' };
    jwks = await startJwksServer(keys);
  });

  afterAll(async () => {
    await jwks.close();
  });

  beforeEach(() => {
    config = {
      resourceServerUrl: 'https://rs.example',
      authorizationServerUrl: 'https://as.example',
      supportedScopes: ['mcp:read'],
      expectedAudience: 'https://rs.example',
      enableDcr: false,
      clockSkewSeconds: 5,
      jwksUri: jwks.url,
    };
  });

  const buildApp = () => {
    const app = express();
    app.get('/.well-known/oauth-protected-resource', (_req, res) =>
      res.json({ ok: 'public' }),
    );
    app.use(createMcpAuthMiddleware(config, createJwksCache()));
    app.get('/mcp', (req, res) =>
      res.json({
        ok: true,
        sub: (req as { mcpAuthToken?: { sub?: string } }).mcpAuthToken?.sub,
      }),
    );
    return app;
  };

  it('passes /.well-known/* through without checking the Authorization header', async () => {
    const res = await request(buildApp()).get(
      '/.well-known/oauth-protected-resource',
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: 'public' });
  });

  it('returns 401 with dynamic WWW-Authenticate when Authorization header is absent', async () => {
    const app = buildApp();
    app.set('trust proxy', true);
    const res = await request(app)
      .get('/mcp')
      .set('Host', 'tunnel.example.com')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Host', 'tunnel.example.com');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(
      /^Bearer realm="https:\/\/tunnel\.example\.com"/,
    );
    expect(res.headers['www-authenticate']).toMatch(
      /resource_metadata="https:\/\/tunnel\.example\.com\/\.well-known\/oauth-protected-resource"/,
    );
    expect(res.body.error).toBe('invalid_token');
  });

  it('uses resourcePath in the WWW-Authenticate realm and metadata URL', async () => {
    const app = express();
    app.set('trust proxy', true);
    app.use(createMcpAuthMiddleware(config, createJwksCache(), '/mcp'));
    app.get('/mcp', (_req, res) => res.json({ ok: true }));
    const res = await request(app)
      .get('/mcp')
      .set('Host', 'tunnel.example.com')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Host', 'tunnel.example.com');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(
      /^Bearer realm="https:\/\/tunnel\.example\.com\/mcp"/,
    );
    expect(res.headers['www-authenticate']).toMatch(
      /resource_metadata="https:\/\/tunnel\.example\.com\/\.well-known\/oauth-protected-resource\/mcp"/,
    );
  });

  it('returns 401 with descriptive body for an expired token', async () => {
    const token = await mintToken(keys, {
      issuer: 'https://as.example',
      audience: 'https://rs.example',
      expSecondsFromNow: -120,
    });
    const res = await request(buildApp())
      .get('/mcp')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_token');
    expect(res.body.error_description).toMatch(/expired/i);
  });

  it('attaches the verified payload to req.mcpAuthToken on a valid token', async () => {
    const token = await mintToken(keys, {
      issuer: 'https://as.example',
      audience: 'https://rs.example',
      expSecondsFromNow: 60,
      sub: 'subject-42',
    });
    const res = await request(buildApp())
      .get('/mcp')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, sub: 'subject-42' });
  });
});
