import type { JWTPayload } from 'jose';
import logging from '../logging';
import {
  AddUserByEmailFunction,
  GetOauthProfileBySubFunction,
  GetUserByEmailFunction,
  OauthProfileResponse,
  OauthProfileType,
  UpdateUserFromOauthProfileFunction,
  UpsertOauthProfileFunction,
  UserBaseType,
} from '../oauth2';

const log = logging('mcp-auth:userResolution');

export type McpResolvedUser = {
  userId: string;
  profile: OauthProfileResponse;
};

export type McpUserResolver = (
  token: string,
  payload: JWTPayload,
) => Promise<McpResolvedUser | undefined>;

export type McpUserResolutionOptions<
  U extends UserBaseType,
  O extends OauthProfileType,
> = {
  // The authorization server's base URL. Used to derive the default
  // /userinfo endpoint. Trailing slash is tolerated.
  authorizationServerUrl: string;
  // Override the /userinfo endpoint if the IdP exposes it elsewhere.
  profileUrl?: string;
  // Cache resolved {userId, profile} by sub for this many ms. Defaults to
  // 5 minutes; set to 0 to disable caching.
  profileCacheTtlMs?: number;
  // The standard local-user upsert callbacks (same shape as the
  // session-based oauth2 helpers in this package).
  getUserByEmail: GetUserByEmailFunction<U>;
  addUserByEmail: AddUserByEmailFunction<U>;
  getOauthProfileBySub: GetOauthProfileBySubFunction<O>;
  upsertOauthProfile: UpsertOauthProfileFunction<O>;
  updateUserFromOauthProfile?: UpdateUserFromOauthProfileFunction<U, O>;
};

const DEFAULT_TTL_MS = 5 * 60 * 1000;

const fetchProfile = async (
  url: string,
  token: string,
): Promise<OauthProfileResponse> => {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`userinfo HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  return (await response.json()) as OauthProfileResponse;
};

const upsertUserAndProfile = async <
  U extends UserBaseType,
  O extends OauthProfileType,
>(
  profile: OauthProfileResponse,
  opts: McpUserResolutionOptions<U, O>,
): Promise<string> => {
  let userId: string;
  let userAdded = false;

  if (!profile.email) {
    const saved = await opts.getOauthProfileBySub(profile.sub);
    if (!saved) {
      const user = await opts.addUserByEmail('', profile);
      userId = user.id;
      userAdded = true;
    } else {
      userId = saved.userId;
    }
  } else {
    let user = await opts.getUserByEmail(profile.email);
    if (!user) {
      user = await opts.addUserByEmail(profile.email, profile);
      userAdded = true;
    }
    userId = user.id;
  }

  const oauthProfile = await opts.upsertOauthProfile(
    profile.sub,
    userId,
    JSON.stringify(profile),
  );
  if (opts.updateUserFromOauthProfile && !userAdded) {
    await opts.updateUserFromOauthProfile(userId, oauthProfile);
  }
  return userId;
};

// Build a resolver that fetches the OIDC profile via /userinfo using the
// presented bearer token, then upserts the local user row + oauth_profile
// row through the consumer-supplied callbacks. Results are cached per `sub`
// for `profileCacheTtlMs` so repeated tool calls don't hammer the IdP.
export const createOidcUserResolver = <
  U extends UserBaseType,
  O extends OauthProfileType,
>(
  opts: McpUserResolutionOptions<U, O>,
): McpUserResolver => {
  const profileUrl =
    opts.profileUrl ??
    `${opts.authorizationServerUrl.replace(/\/+$/, '')}/userinfo`;
  const ttlMs = opts.profileCacheTtlMs ?? DEFAULT_TTL_MS;
  const cache = new Map<
    string,
    { result: McpResolvedUser; expiresAt: number }
  >();

  return async (token, payload) => {
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

    try {
      const profile = await fetchProfile(profileUrl, token);
      if (profile.sub !== sub) {
        log.warn(
          `userinfo sub (${profile.sub}) does not match token sub (${sub}); using token sub`,
        );
        profile.sub = sub;
      }
      const userId = await upsertUserAndProfile(profile, opts);
      const result: McpResolvedUser = { userId, profile };
      if (ttlMs > 0) {
        cache.set(sub, { result, expiresAt: Date.now() + ttlMs });
      }
      return result;
    } catch (err) {
      log.error(
        `User resolution failed for sub=${sub}: ${(err as Error).message}`,
      );
      return undefined;
    }
  };
};
