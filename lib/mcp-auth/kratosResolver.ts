import type { JWTPayload } from 'jose';
import logging from '../logging';
import { OauthProfileResponse } from '../oauth2';
import { McpResolvedUser, McpUserResolver } from './userResolution';

const log = logging('mcp-auth:kratosResolver');

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_NAMESPACE = 'https://hikari-systems.com/';

type KratosTraits = {
  email?: string;
  name?: string;
  picture?: string;
};

type KratosMetadataPublic = {
  terms?: { version?: string; accepted_at?: string } | null;
};

type KratosIdentity = {
  id: string;
  traits?: KratosTraits;
  metadata_public?: KratosMetadataPublic | null;
  verifiable_addresses?: { value: string; verified: boolean; via: string }[];
};

const claim = (
  payload: Record<string, unknown>,
  key: string,
): string | undefined => {
  const v = payload[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
};

const profileFromClaims = (
  payload: JWTPayload,
  ns: string,
): OauthProfileResponse | undefined => {
  const sub = payload.sub;
  if (typeof sub !== 'string' || sub.length === 0) return undefined;
  const p = payload as Record<string, unknown>;
  return {
    sub,
    email: claim(p, `${ns}email`),
    name: claim(p, `${ns}name`),
    picture: claim(p, `${ns}picture`),
  };
};

export type KratosResolverOpts = {
  // Kratos admin API base URL, e.g. http://kratos:4434
  kratosAdminUrl: string;
  // Custom claims namespace; defaults to 'https://hikari-systems.com/'.
  // Must match the namespace the login-consent-app injects into JWTs.
  claimsNamespace?: string;
  // If true, fall back to Kratos admin /admin/identities/{sub} when JWT
  // claims are missing or empty (e.g. tokens minted before the consent app
  // started injecting custom claims). Defaults to true.
  fallbackToKratosAdmin?: boolean;
  // Cache TTL in ms. Defaults to 5 minutes; set to 0 to disable.
  cacheTtlMs?: number;
};

// Builds a McpUserResolver that derives the user from the verified JWT.
// Primary path: read namespaced claims (email, name, picture) directly off
// the access token — Hydra's consent app injects them from Kratos identity
// traits, so they're always fresh at issuance time. Fallback path: hit
// Kratos admin /admin/identities/{sub} if claims are absent. The Kratos
// identity ID (which is also `sub`) is used as the user ID — no UDS upsert.
export const createKratosUserResolver = (
  opts: KratosResolverOpts,
): McpUserResolver => {
  const adminUrl = opts.kratosAdminUrl.replace(/\/+$/, '');
  if (!adminUrl) {
    throw new Error('createKratosUserResolver: kratosAdminUrl is required');
  }
  const ns = opts.claimsNamespace ?? DEFAULT_NAMESPACE;
  const fallback = opts.fallbackToKratosAdmin ?? true;
  const ttlMs = opts.cacheTtlMs ?? DEFAULT_TTL_MS;
  const cache = new Map<
    string,
    { result: McpResolvedUser; expiresAt: number }
  >();

  const fetchIdentity = async (
    id: string,
  ): Promise<KratosIdentity | undefined> => {
    try {
      const r = await fetch(
        `${adminUrl}/admin/identities/${encodeURIComponent(id)}`,
        { headers: { Accept: 'application/json' } },
      );
      if (r.status === 404) return undefined;
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        log.warn(
          `Kratos identity lookup ${id} → ${r.status}: ${body.slice(0, 200)}`,
        );
        return undefined;
      }
      return (await r.json()) as KratosIdentity;
    } catch (err) {
      log.error(
        `Kratos identity lookup ${id} failed: ${(err as Error).message}`,
      );
      return undefined;
    }
  };

  return async (_token, payload) => {
    const sub = payload.sub;
    if (typeof sub !== 'string' || sub.length === 0) {
      log.warn('JWT missing sub; skipping user resolution');
      return undefined;
    }

    if (ttlMs > 0) {
      const cached = cache.get(sub);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.result;
      }
    }

    let profile = profileFromClaims(payload, ns);

    const needsFallback =
      fallback &&
      (!profile || (!profile.email && !profile.name && !profile.picture));
    if (needsFallback) {
      const identity = await fetchIdentity(sub);
      if (identity) {
        profile = {
          sub,
          email: identity.traits?.email ?? profile?.email,
          name: identity.traits?.name ?? profile?.name,
          picture: identity.traits?.picture ?? profile?.picture,
        };
      }
    }

    if (!profile) return undefined;

    // Kratos identity ID == JWT sub == our internal user ID. No upsert.
    const result: McpResolvedUser = { userId: sub, profile };
    if (ttlMs > 0) {
      cache.set(sub, { result, expiresAt: Date.now() + ttlMs });
    }
    return result;
  };
};
