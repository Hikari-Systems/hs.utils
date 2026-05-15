import express from 'express';
import request from 'supertest';
import {
  createClientStore,
  createDcrHandler,
  createDcrRateLimitStore,
} from '../../lib/mcp-auth/dcr';
import { AuthConfig } from '../../lib/mcp-auth/config';

const baseConfig: AuthConfig = {
  resourceServerUrl: 'https://rs.example',
  authorizationServerUrl: 'https://as.example',
  supportedScopes: ['mcp:read'],
  expectedAudience: 'https://rs.example',
  enableDcr: true,
  clockSkewSeconds: 30,
};

const buildApp = () => {
  const app = express();
  const store = createClientStore();
  const rateLimit = createDcrRateLimitStore();
  app.post(
    '/register',
    express.json(),
    createDcrHandler(baseConfig, store, rateLimit),
  );
  return { app, store };
};

describe('createDcrHandler', () => {
  it('rejects non-localhost http:// redirect URIs with 400 invalid_redirect_uri', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/register')
      .send({ redirect_uris: ['http://evil.example/cb'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_redirect_uri');
  });

  it('accepts https:// redirect URIs', async () => {
    const { app, store } = buildApp();
    const res = await request(app)
      .post('/register')
      .send({ redirect_uris: ['https://client.example/cb'] });
    expect(res.status).toBe(201);
    expect(typeof res.body.client_id).toBe('string');
    expect(res.body.redirect_uris).toEqual(['https://client.example/cb']);
    expect(res.body.grant_types).toEqual(['authorization_code']);
    expect(res.body.response_types).toEqual(['code']);
    expect(res.body.token_endpoint_auth_method).toBe('none');
    expect(typeof res.body.client_id_issued_at).toBe('number');
    expect(await store.get(res.body.client_id)).toBeDefined();
  });

  it('accepts http://localhost redirect URIs (dev exception)', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/register')
      .send({ redirect_uris: ['http://localhost:3000/cb'] });
    expect(res.status).toBe(201);
  });

  it('accepts http://127.0.0.1 redirect URIs (dev exception)', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/register')
      .send({ redirect_uris: ['http://127.0.0.1:3000/cb'] });
    expect(res.status).toBe(201);
  });

  it('rejects an empty redirect_uris array with 400', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/register')
      .send({ redirect_uris: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client_metadata');
  });

  it('returns 429 after 5 successful registrations from the same IP within 60s', async () => {
    const { app } = buildApp();
    const body = { redirect_uris: ['https://client.example/cb'] };
    for (let i = 0; i < 5; i += 1) {
      const ok = await request(app).post('/register').send(body);
      expect(ok.status).toBe(201);
    }
    const sixth = await request(app).post('/register').send(body);
    expect(sixth.status).toBe(429);
    expect(sixth.body.error).toBe('too_many_requests');
  });
});
