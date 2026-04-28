import {
  createRemoteJWKSet,
  jwtVerify,
  errors as joseErrors,
  JWTPayload,
} from 'jose';
import { AuthConfig } from './config';

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

const jwksUriCache = new Map<string, string>();

const resolveJwksUri = async (config: AuthConfig): Promise<string> => {
  if (config.jwksUri) return config.jwksUri;

  const cached = jwksUriCache.get(config.authorizationServerUrl);
  if (cached) return cached;

  const upstream = `${config.authorizationServerUrl.replace(
    /\/+$/,
    '',
  )}/.well-known/oauth-authorization-server`;
  const response = await fetch(upstream, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new TokenVerificationError(
      'unknown',
      `Could not discover jwks_uri from ${upstream}: HTTP ${response.status}`,
    );
  }
  const meta = (await response.json()) as { jwks_uri?: unknown };
  if (typeof meta.jwks_uri !== 'string' || meta.jwks_uri === '') {
    throw new TokenVerificationError(
      'unknown',
      `Authorization server metadata at ${upstream} did not include a jwks_uri.`,
    );
  }
  jwksUriCache.set(config.authorizationServerUrl, meta.jwks_uri);
  return meta.jwks_uri;
};

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

const getJwks = async (
  config: AuthConfig,
): Promise<ReturnType<typeof createRemoteJWKSet>> => {
  const uri = await resolveJwksUri(config);
  const existing = jwksCache.get(uri);
  if (existing) return existing;
  const jwks = createRemoteJWKSet(new URL(uri));
  jwksCache.set(uri, jwks);
  return jwks;
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
  (config: AuthConfig) =>
  async (token: string): Promise<JWTPayload> => {
    if (typeof token !== 'string' || token.length === 0) {
      throw new TokenVerificationError('malformed', 'Empty token');
    }
    const jwks = await getJwks(config);
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: config.authorizationServerUrl,
        audience: config.expectedAudience,
        clockTolerance: config.clockSkewSeconds,
      });
      return payload;
    } catch (err) {
      throw mapJoseError(err);
    }
  };

export const resetVerifierCachesForTests = (): void => {
  jwksUriCache.clear();
  jwksCache.clear();
};
