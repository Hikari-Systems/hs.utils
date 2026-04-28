import http from 'http';
import { AddressInfo } from 'net';
import { SignJWT, generateKeyPair, exportJWK, KeyLike, JWK } from 'jose';
import {
  TokenVerificationError,
  resetVerifierCachesForTests,
  createTokenVerifier,
} from '../../lib/mcp-auth/tokenVerifier';
import { AuthConfig } from '../../lib/mcp-auth/config';

type Keys = {
  privateKey: KeyLike;
  publicJwk: JWK;
  kid: string;
};

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
  payload: Record<string, unknown>,
  opts: { issuer: string; audience: string; expSecondsFromNow: number },
): Promise<string> =>
  new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: keys.kid })
    .setIssuedAt()
    .setIssuer(opts.issuer)
    .setAudience(opts.audience)
    .setExpirationTime(Math.floor(Date.now() / 1000) + opts.expSecondsFromNow)
    .sign(keys.privateKey);

describe('createTokenVerifier', () => {
  let keys: Keys;
  let jwksServer: { url: string; close: () => Promise<void> };
  let config: AuthConfig;

  beforeAll(async () => {
    const kp = await generateKeyPair('RS256');
    const publicJwk = await exportJWK(kp.publicKey);
    keys = { privateKey: kp.privateKey, publicJwk, kid: 'test-kid' };
    jwksServer = await startJwksServer(keys);
  });

  afterAll(async () => {
    await jwksServer.close();
  });

  beforeEach(() => {
    resetVerifierCachesForTests();
    config = {
      resourceServerUrl: 'https://rs.example',
      authorizationServerUrl: 'https://as.example',
      supportedScopes: ['mcp:read'],
      expectedAudience: 'https://rs.example',
      enableDcr: false,
      clockSkewSeconds: 5,
      jwksUri: jwksServer.url,
    };
  });

  it('resolves with the payload for a valid token', async () => {
    const token = await mintToken(
      keys,
      { sub: 'user-1' },
      {
        issuer: 'https://as.example',
        audience: 'https://rs.example',
        expSecondsFromNow: 60,
      },
    );
    const verify = createTokenVerifier(config);
    const payload = await verify(token);
    expect(payload.sub).toBe('user-1');
    expect(payload.aud).toBe('https://rs.example');
  });

  it('throws TokenVerificationError(reason="expired") for expired tokens', async () => {
    const token = await mintToken(
      keys,
      { sub: 'u' },
      {
        issuer: 'https://as.example',
        audience: 'https://rs.example',
        expSecondsFromNow: -120,
      },
    );
    const verify = createTokenVerifier(config);
    await expect(verify(token)).rejects.toMatchObject({
      name: 'TokenVerificationError',
      reason: 'expired',
    });
  });

  it('throws TokenVerificationError(reason="wrong_audience") for audience mismatch', async () => {
    const token = await mintToken(
      keys,
      { sub: 'u' },
      {
        issuer: 'https://as.example',
        audience: 'https://other.example',
        expSecondsFromNow: 60,
      },
    );
    const verify = createTokenVerifier(config);
    await expect(verify(token)).rejects.toMatchObject({
      name: 'TokenVerificationError',
      reason: 'wrong_audience',
    });
  });

  it('throws TokenVerificationError(reason="malformed") for non-JWT input', async () => {
    const verify = createTokenVerifier(config);
    await expect(verify('not-a-jwt')).rejects.toMatchObject({
      name: 'TokenVerificationError',
      reason: 'malformed',
    });
  });

  it('throws TokenVerificationError(reason="malformed") for empty string', async () => {
    const verify = createTokenVerifier(config);
    await expect(verify('')).rejects.toBeInstanceOf(TokenVerificationError);
  });
});
