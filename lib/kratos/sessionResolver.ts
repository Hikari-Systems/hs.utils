import logging from '../logging';
import { OauthProfileResponse } from '../oauth2';
import {
  DEFAULT_CLAIMS_NAMESPACE,
  KratosClaimProfile,
  readKratosClaims,
} from './claims';

const log = logging('kratos:sessionResolver');

const DEFAULT_TTL_MS = 5 * 60 * 1000;

type KratosTraits = {
  email?: string;
  name?: string;
  picture?: string;
  pictureId?: string;
};

type KratosMetadataPublic = {
  terms?: { version?: string; accepted_at?: string } | null;
};

type KratosIdentity = {
  id: string;
  traits?: KratosTraits;
  metadata_public?: KratosMetadataPublic | null;
};

// Resolved cookie-session user. The id is always the Kratos identity ID
// (which is also the JWT sub). The profile is what the GraphQL layer
// surfaces to the dashboard UI.
export type KratosSessionProfile = Required<Pick<KratosClaimProfile, never>> &
  KratosClaimProfile;

export type KratosSessionUser = {
  sub: string;
  profile: KratosSessionProfile;
};

export type KratosSessionResolverOpts = {
  // Kratos admin API base URL, e.g. http://kratos:4434
  kratosAdminUrl: string;
  // Custom claims namespace; defaults to 'https://hikari-systems.com/'.
  // Must match the namespace the consent app injects.
  claimsNamespace?: string;
  // If true, fall back to Kratos admin /admin/identities/{sub} when the
  // userinfo response is missing the namespaced claims (e.g. tokens minted
  // before the consent app started injecting them, or local dev against a
  // bare Hydra). Defaults to true.
  fallbackToKratosAdmin?: boolean;
  // Cache TTL in ms. Defaults to 5 minutes; set to 0 to disable.
  cacheTtlMs?: number;
};

// Resolves a cookie-session user from a Hydra userinfo response, with an
// optional Kratos admin fallback. This is the cookie-session sibling of
// `createKratosUserResolver` (which is for MCP/JWT bearer flow). It is the
// resolver that `authorizeKratosMiddleware` plugs in by default, and is
// also exposed standalone so resolvers (e.g. WorkspaceType.owner) can
// look up profiles for *other* users by their Kratos identity ID.
export const createKratosSessionResolver = (
  opts: KratosSessionResolverOpts,
) => {
  const adminUrl = opts.kratosAdminUrl.replace(/\/+$/, '');
  if (!adminUrl) {
    throw new Error('createKratosSessionResolver: kratosAdminUrl is required');
  }
  const ns = opts.claimsNamespace ?? DEFAULT_CLAIMS_NAMESPACE;
  const fallback = opts.fallbackToKratosAdmin ?? true;
  const ttlMs = opts.cacheTtlMs ?? DEFAULT_TTL_MS;
  const cache = new Map<
    string,
    { user: KratosSessionUser; expiresAt: number }
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

  const profileFromIdentity = (
    identity: KratosIdentity,
  ): KratosSessionProfile => {
    const terms = identity.metadata_public?.terms ?? null;
    return {
      email: identity.traits?.email,
      name: identity.traits?.name,
      pictureImageServiceId:
        identity.traits?.pictureId ?? identity.traits?.picture,
      termsVersion: terms?.version,
      termsAcceptedAt: terms?.accepted_at,
    };
  };

  const writeCache = (sub: string, user: KratosSessionUser) => {
    if (ttlMs > 0) {
      cache.set(sub, { user, expiresAt: Date.now() + ttlMs });
    }
  };

  return {
    // Resolve from the userinfo response we just fetched on the OAuth
    // callback. Falls back to Kratos admin when the namespaced claims are
    // missing (which happens when running against a bare Hydra without the
    // consent app, or against tokens issued before claim injection was
    // turned on).
    resolveFromProfile: async (
      profile: OauthProfileResponse,
    ): Promise<KratosSessionUser | undefined> => {
      const sub = profile.sub;
      if (!sub) {
        log.warn('userinfo response has no sub; cannot resolve');
        return undefined;
      }

      const claims = readKratosClaims(
        profile as unknown as Record<string, unknown>,
        ns,
      );
      const haveAny =
        claims.email ||
        claims.name ||
        claims.pictureImageServiceId ||
        claims.termsVersion;

      let resolved: KratosSessionProfile = {
        email: claims.email ?? profile.email,
        name: claims.name ?? profile.name,
        // Standard OIDC `picture` is treated as legacy — once the consent
        // app is in the loop the namespaced pictureId claim is what we
        // care about.
        pictureImageServiceId: claims.pictureImageServiceId,
        termsVersion: claims.termsVersion,
        termsAcceptedAt: claims.termsAcceptedAt,
      };

      if (!haveAny && fallback) {
        const identity = await fetchIdentity(sub);
        if (identity) {
          resolved = profileFromIdentity(identity);
        }
      }

      const user: KratosSessionUser = { sub, profile: resolved };
      writeCache(sub, user);
      return user;
    },

    // Look up another user by their Kratos identity ID. Used by GraphQL
    // resolvers that need to render someone other than the current user
    // (e.g. WorkspaceType.owner). Cached.
    lookupBySub: async (
      sub: string,
    ): Promise<KratosSessionUser | undefined> => {
      if (!sub) return undefined;
      if (ttlMs > 0) {
        const cached = cache.get(sub);
        if (cached && cached.expiresAt > Date.now()) {
          return cached.user;
        }
      }
      const identity = await fetchIdentity(sub);
      if (!identity) return undefined;
      const user: KratosSessionUser = {
        sub,
        profile: profileFromIdentity(identity),
      };
      writeCache(sub, user);
      return user;
    },

    // Drop a sub from the cache — useful right after writing terms via
    // `createKratosIdentityWriter` so the next request reads fresh data.
    invalidate: (sub: string): void => {
      cache.delete(sub);
    },
  };
};

export type KratosSessionResolver = ReturnType<
  typeof createKratosSessionResolver
>;
