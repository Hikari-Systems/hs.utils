import express, { RequestHandler } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AuthConfig } from './config';

export type ClientRegistration = {
  client_id: string;
  client_id_issued_at: number;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
};

export type ClientStore = {
  get(id: string): ClientRegistration | undefined;
  set(id: string, reg: ClientRegistration): void;
};

export const createClientStore = (): ClientStore => {
  // TODO: replace with persistent store before production
  const store = new Map<string, ClientRegistration>();
  return {
    get: (id) => store.get(id),
    set: (id, reg) => {
      store.set(id, reg);
    },
  };
};

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 5;

export const dcrRateLimit = new Map<string, number[]>();

export const resetDcrRateLimitForTests = (): void => {
  dcrRateLimit.clear();
};

const isAcceptableRedirectUri = (uri: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol === 'http:') {
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  }
  return false;
};

const recordAndCheckRate = (ip: string): boolean => {
  const now = Date.now();
  const window = (dcrRateLimit.get(ip) ?? []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS,
  );
  if (window.length >= RATE_LIMIT_MAX) {
    dcrRateLimit.set(ip, window);
    return false;
  }
  window.push(now);
  dcrRateLimit.set(ip, window);
  return true;
};

const jsonError = (
  res: express.Response,
  status: number,
  error: string,
  description?: string,
): void => {
  res.setHeader('Content-Type', 'application/json');
  res
    .status(status)
    .json(
      description === undefined
        ? { error }
        : { error, error_description: description },
    );
};

export const createDcrHandler =
  (_config: AuthConfig, store: ClientStore): RequestHandler =>
  (req, res) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    if (!recordAndCheckRate(ip)) {
      jsonError(
        res,
        429,
        'too_many_requests',
        'DCR rate limit exceeded; try again shortly.',
      );
      return;
    }

    const { body } = req;
    if (!body || typeof body !== 'object') {
      jsonError(
        res,
        400,
        'invalid_client_metadata',
        'Request body must be JSON.',
      );
      return;
    }

    const redirectUris = (body as { redirect_uris?: unknown }).redirect_uris;
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      !redirectUris.every((u) => typeof u === 'string')
    ) {
      jsonError(
        res,
        400,
        'invalid_client_metadata',
        'redirect_uris must be a non-empty array of strings.',
      );
      return;
    }

    const badUri = (redirectUris as string[]).find(
      (uri) => !isAcceptableRedirectUri(uri),
    );
    if (badUri !== undefined) {
      jsonError(
        res,
        400,
        'invalid_redirect_uri',
        `Redirect URI not permitted: ${badUri}. Use https:// or http://localhost.`,
      );
      return;
    }

    const clientId = uuidv4();
    const registration: ClientRegistration = {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris as string[],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
    store.set(clientId, registration);

    res.setHeader('Content-Type', 'application/json');
    res.status(201).json(registration);
  };
