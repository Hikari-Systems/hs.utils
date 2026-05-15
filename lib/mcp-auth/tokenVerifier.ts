import {
  createLocalJWKSet,
  jwtVerify,
  errors as joseErrors,
  JWTPayload,
} from 'jose';
import { AuthConfig } from './config';
import { JwksCache, JsonWebKeySet, createJwksCache } from './stores';

export type VerificationReason =
  | 'expired'
  | 'invalid_signature'
  | 'wrong_audience'
  | 'malformed'
  | 'unknown';

export class TokenVerificationError extends Error {
  public readonly reason: VerificationReason;

  constructor(reason: VerificationReason, message?: string) {
    super(message ?? reason);
    this.name = 'TokenVerificationError';
    this.reason = reason;
  }
}

const fetchJson = async (url: string): Promise<unknown> => {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new TokenVerificationError(
      'unknown',
      `HTTP ${response.status} fetching ${url}`,
    );
  }
  return response.json();
};

const discoverJwksUri = async (config: AuthConfig): Promise<string> => {
  if (config.jwksUri) return config.jwksUri;
  const upstream = `${config.authorizationServerUrl.replace(
    /\/+$/,
    '',
  )}/.well-known/oauth-authorization-server`;
  const meta = (await fetchJson(upstream)) as { jwks_uri?: unknown };
  if (typeof meta.jwks_uri !== 'string' || meta.jwks_uri === '') {
    throw new TokenVerificationError(
      'unknown',
      `Authorization server metadata at ${upstream} did not include a jwks_uri.`,
    );
  }
  return meta.jwks_uri;
};

const fetchJwks = async (jwksUri: string): Promise<JsonWebKeySet> => {
  const body = (await fetchJson(jwksUri)) as { keys?: unknown };
  if (!body || typeof body !== 'object' || !Array.isArray(body.keys)) {
    throw new TokenVerificationError(
      'unknown',
      `JWKS at ${jwksUri} did not contain a "keys" array.`,
    );
  }
  return body as JsonWebKeySet;
};

const mapJoseError = (err: unknown): TokenVerificationError => {
  if (err instanceof TokenVerificationError) return err;
  if (err instanceof joseErrors.JWTExpired) {
    return new TokenVerificationError('expired', 'Token has expired');
  }
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    if (err.claim === 'aud') {
      return new TokenVerificationError(
        'wrong_audience',
        'Token audience does not match expected resource',
      );
    }
    return new TokenVerificationError(
      'unknown',
      `Claim validation failed: ${err.claim}`,
    );
  }
  if (
    err instanceof joseErrors.JWSSignatureVerificationFailed ||
    err instanceof joseErrors.JWKSNoMatchingKey
  ) {
    return new TokenVerificationError(
      'invalid_signature',
      'Token signature could not be verified',
    );
  }
  if (
    err instanceof joseErrors.JWTInvalid ||
    err instanceof joseErrors.JWSInvalid
  ) {
    return new TokenVerificationError('malformed', 'Token is malformed');
  }
  return new TokenVerificationError('unknown');
};

export const createTokenVerifier =
  (config: AuthConfig, cache: JwksCache = createJwksCache()) =>
  async (token: string): Promise<JWTPayload> => {
    if (typeof token !== 'string' || token.length === 0) {
      throw new TokenVerificationError('malformed', 'Empty token');
    }

    const cached = await cache.get(config.authorizationServerUrl);
    let jwksDoc: JsonWebKeySet;
    let jwksUri: string;
    if (cached) {
      ({ jwks: jwksDoc, jwksUri } = cached);
    } else {
      jwksUri = await discoverJwksUri(config);
      jwksDoc = await fetchJwks(jwksUri);
      await cache.set(config.authorizationServerUrl, jwksUri, jwksDoc);
    }

    const keySet = createLocalJWKSet(
      jwksDoc as unknown as Parameters<typeof createLocalJWKSet>[0],
    );

    // Accept iss with or without a trailing slash. Some IdPs (Auth0) issue
    // tokens whose iss includes a trailing slash regardless of how the
    // authorization server URL is configured here, and `jose` does exact
    // string matching.
    const issWithSlash = config.authorizationServerUrl.endsWith('/')
      ? config.authorizationServerUrl
      : `${config.authorizationServerUrl}/`;
    const issWithoutSlash = issWithSlash.replace(/\/+$/, '');

    try {
      const { payload } = await jwtVerify(token, keySet, {
        issuer: [issWithSlash, issWithoutSlash],
        audience: config.expectedAudience,
        clockTolerance: config.clockSkewSeconds,
      });
      return payload;
    } catch (err) {
      throw mapJoseError(err);
    }
  };
