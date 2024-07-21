import express from 'express';
import dayjs from 'dayjs';
import { v4 } from 'uuid';

import config from '../config';
import logging from '../logging';
import { delRedisVal, getRedisVal, setRedisVal } from '../redis';
import { LocalNextFunction, LocalRequest, LocalResponse } from '../types';
import { forwardedFor } from '../forwardedFor';

const log = logging('middleware:authentication');

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
  id_token: string;
  nonce?: string;
}

export interface OauthProfileResponse {
  sub: string;
  given_name?: string;
  family_name?: string;
  name?: string;
  email?: string;
  email_verified?: boolean;
  nickname?: string;
  picture?: string;
  updated_at?: string;
}

const doTokenExchange = async (
  code: string,
  redirectUri: string,
): Promise<TokenResponse> => {
  try {
    const response = await fetch(config.get('oauth2:tokenUrl'), {
      method: 'POST',
      body: JSON.stringify({
        client_id: config.get('oauth2:clientId'),
        client_secret: config.get('oauth2:clientSecret'),
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code,
      }),
      headers: {
        'Content-type': 'application/json',
      },
    });
    const tokenResponse = await response.text();
    log.debug(`Token exchange response  is ${tokenResponse}`);
    return JSON.parse(tokenResponse) as TokenResponse;
  } catch (err) {
    log.error(`Error doing token exchange: ${code}`, err);
    throw err;
  }
};

const doTokenRefresh = async (refreshToken: string): Promise<TokenResponse> => {
  try {
    const response = await fetch(config.get('oauth2:tokenUrl'), {
      method: 'POST',
      body: JSON.stringify({
        client_id: config.get('oauth2:clientId'),
        client_secret: config.get('oauth2:clientSecret'),
        grant_type: 'refresh_token',
        token: refreshToken,
      }),
      headers: {
        'Content-type': 'application/json',
      },
    });
    const tokenResponse = await response.text();
    log.debug(`Token refresh response  is ${tokenResponse}`);
    return JSON.parse(tokenResponse) as TokenResponse;
  } catch (err) {
    log.error(`Error doing token refresh: ${refreshToken}`, err);
    throw err;
  }
};

const getOauthProfileByToken = async (
  token: string,
): Promise<OauthProfileResponse> => {
  try {
    const response = await fetch(config.get('oauth2:profileUrl'), {
      headers: {
        'Content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    const profileResponse = await response.text();
    log.debug(`Profile is ${profileResponse}`);
    return JSON.parse(profileResponse) as OauthProfileResponse;
  } catch (err) {
    log.error(`Error doing profile download: ${token}`, err);
    throw err;
  }
};

// ////////////////////////////

export type GetUserByEmailFunction<U> = (
  email: string,
) => Promise<(U & { id: string }) | null>;
export type AddUserByEmailFunction<U> = (
  email: string,
  profile: OauthProfileResponse,
) => Promise<U & { id: string }>;
export type GetOauthProfileBySubFunction<O> = (
  sub: string,
) => Promise<O | null>;
export type UpsertOauthProfileFunction<O> = (
  sub: string,
  userId: string,
  profileJson: string,
) => Promise<O>;

export interface UserBaseType {
  email: string;
}
export interface OauthProfileType {
  sub: string;
  userId: string;
  profileJson: string;
}

type ERROR_HANDLER_TYPE = (
  err: Error,
  req: LocalRequest,
  res: LocalResponse,
  next: LocalNextFunction,
) => Promise<void>;

const doUserRowCreation = async <
  U extends UserBaseType,
  O extends OauthProfileType,
>(
  dlProfile: OauthProfileResponse,
  getUserByEmail: GetUserByEmailFunction<U>,
  addUserByEmail: AddUserByEmailFunction<U>,
  getOauthProfileBySub: GetOauthProfileBySubFunction<O>,
  upsertOauthProfile: UpsertOauthProfileFunction<O>,
) => {
  let userId;
  if (!dlProfile.email) {
    const savedProfile = await getOauthProfileBySub(dlProfile.sub);
    if (!savedProfile) {
      const user = await addUserByEmail('', dlProfile);
      userId = user.id;
    } else {
      userId = savedProfile.userId;
    }
  } else {
    let user = await getUserByEmail(dlProfile.email);
    if (!user) {
      user = await addUserByEmail(dlProfile.email, dlProfile);
    }
    userId = user.id;
  }

  await upsertOauthProfile(dlProfile.sub, userId, JSON.stringify(dlProfile));
  return userId;
};

// ////////////////////////////

export const doAuthorizeRedirect = async (
  path: string,
  req: LocalRequest,
  res: LocalResponse,
) => {
  const { baseUrl } = forwardedFor(req);
  const redirectUri = `${baseUrl}/oauth2/callback`;
  const stateKey = v4();
  await setRedisVal(`authState:${stateKey}`, `${baseUrl}${path}`);

  // build authorization url
  const authorizeUrl = `${config.get('oauth2:authorizeUrl')}?response_type=code&client_id=${encodeURIComponent(
    config.get('oauth2:clientId'),
  )}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(
    config.get('oauth2:scopes'),
  )}&state=${encodeURIComponent(stateKey)}`;
  log.debug(
    `Sending authorization request for ${req.url}: url=${authorizeUrl}`,
  );
  return res.redirect(authorizeUrl);
};

export const DEFAULT_ERROR_HANDLER =
  (statusCode: number): ERROR_HANDLER_TYPE =>
  (inErr, _inReq, inRes) => {
    log.error(`Error ${statusCode}: ${inErr}`);
    inRes.status(statusCode).send('Error');
    return Promise.resolve();
  };

export interface Oauth2PathConfig {
  regex: RegExp;
  whitelist: boolean;
  failFast: boolean;
}

export const authorizeMiddleware = <
  T extends UserBaseType,
  U extends OauthProfileType,
>(
  pathConfigs: Oauth2PathConfig[],
  getUserByEmail: GetUserByEmailFunction<T>,
  addUserByEmail: AddUserByEmailFunction<T>,
  getOauthProfileBySub: GetOauthProfileBySubFunction<U>,
  upsertOauthProfile: UpsertOauthProfileFunction<U>,
  callbackUri = '/oauth2/callback',
  callbackErrorHandler = DEFAULT_ERROR_HANDLER(400),
) => {
  const router = express.Router();
  router.get(
    callbackUri,
    async (req: LocalRequest, res: LocalResponse, next: LocalNextFunction) => {
      const {
        code,
        state: stateKey,
        error,
      } = req.query as {
        code?: string;
        state: string;
        error?: string;
      };
      const { baseUrl } = forwardedFor(req);
      log.debug(
        `Authorization callback: code=${code} state=${stateKey} error=${error}`,
      );
      try {
        if (error) {
          throw new Error(error);
        }
        if (!code) {
          throw new Error('No code supplied');
        }
        const redirectUri = await getRedisVal(`authState:${stateKey}`);
        if (!redirectUri) {
          throw new Error(`No state found: key=${stateKey}`);
        }

        const tokenResp = await doTokenExchange(
          code,
          `${baseUrl}/oauth2/callback`,
        );
        if (!tokenResp?.access_token) {
          throw new Error(`No access token in response`);
        }
        await delRedisVal(`authState:${stateKey}`);

        const dlProfile = await getOauthProfileByToken(tokenResp?.access_token);

        const userId = await doUserRowCreation(
          dlProfile,
          getUserByEmail,
          addUserByEmail,
          getOauthProfileBySub,
          upsertOauthProfile,
        );

        req.session.user = {
          userId,
          accessToken: tokenResp.access_token,
          refreshToken: tokenResp?.refresh_token,
          expiresAt: tokenResp?.expires_in
            ? dayjs().add(tokenResp.expires_in, 'second')
            : null,
        };

        // validate state, get redirectUrl
        const origUrl = redirectUri || '/';
        log.debug(`Redirecting to ${origUrl}`);
        return res.redirect(origUrl);
      } catch (err: any) {
        return callbackErrorHandler(err, req, res, next);
      }
    },
  );

  router.use(
    async (req: LocalRequest, res: LocalResponse, next: LocalNextFunction) => {
      const path = req.baseUrl + req.path;
      const matchedPath = pathConfigs?.find((x) => x.regex.test(path));
      if (!matchedPath) {
        return next(
          new Error(`ERROR: No matching auth path config found at ${path}`),
        );
      }
      req.getLoggedInUserId = (): string | null => {
        const user = req?.session?.user;
        return user?.userId || null;
      };
      req.getAccessToken = async (): Promise<string | null> => {
        const user = req?.session?.user;
        if (!user) {
          return null;
        }
        if (
          !user.accessToken ||
          (user.expiresAt && user.expiresAt.isBefore(dayjs()))
        ) {
          if (user.refreshToken) {
            const tokenResp = await doTokenRefresh(user.refreshToken);
            req.session.user = {
              userId: user.userId,
              accessToken: tokenResp.access_token,
              refreshToken: tokenResp?.refresh_token,
              expiresAt: tokenResp?.expires_in
                ? dayjs().add(tokenResp.expires_in, 'second')
                : null,
            };
            return tokenResp.access_token || null;
          }
          req.session.user = {
            userId: user.userId,
            accessToken: null,
            refreshToken: null,
            expiresAt: null,
          };
          return null;
        }
        return user.accessToken || null;
      };
      if (matchedPath.whitelist) {
        // log.debug(`Auth: allowing whitelisted path ${path}`);
        return next();
      }
      const userId = req.getLoggedInUserId();
      if (matchedPath?.failFast) {
        if (!userId) {
          log.debug(`Auth: rejecting, not logged in on failfast path ${path}`);
          return res.status(401).send(`not logged in`);
        }
        // log.debug(`Authentication check passed (failfast): ${path}`);
        return next();
      }
      if (userId) {
        // log.debug(`Authentication check passed: ${path}`);
        return next();
      }
      return doAuthorizeRedirect(req.url, req, res);
    },
  );
  return router;
};

/*
 * aim to keep the getLoggedInUser function returning the logged in user even if whitelisted
 */
export const bearerMiddleware =
  <T extends UserBaseType, U extends OauthProfileType>(
    pathConfigs: Oauth2PathConfig[],
    getUserByEmail: GetUserByEmailFunction<T>,
    addUserByEmail: AddUserByEmailFunction<T>,
    getOauthProfileBySub: GetOauthProfileBySubFunction<U>,
    upsertOauthProfile: UpsertOauthProfileFunction<U>,
    authErrorHandler = DEFAULT_ERROR_HANDLER(401),
  ) =>
  async (req: LocalRequest, res: LocalResponse, next: LocalNextFunction) => {
    const path = req.baseUrl + req.path;
    const matchedPath = pathConfigs?.find((x) => x.regex.test(path));
    if (!matchedPath) {
      return next(
        new Error(`ERROR: No matching auth path config found at ${path}`),
      );
    }
    const { whitelist: whitelisted } = matchedPath;

    const token = (() => {
      const authHeader = req.headers?.authorization?.trim();
      if (authHeader?.toLowerCase().startsWith('bearer ')) {
        return (authHeader || 'bearer ').substring(7).trim();
      }
      return '';
    })();

    if (!whitelisted && token === '') {
      return authErrorHandler(
        new Error(`No bearer/access token supplied`),
        req,
        res,
        next,
      );
    }
    try {
      const userId: string | null = await (async () => {
        if ((token || '') === '') {
          return null; // must be whitelisted and not logged in
        }
        // Passing token to back end oauth-provider
        const dlProfile = await getOauthProfileByToken(token);
        const dlUserId = await doUserRowCreation(
          dlProfile,
          getUserByEmail,
          addUserByEmail,
          getOauthProfileBySub,
          upsertOauthProfile,
        );
        return dlUserId;
      })();

      req.getLoggedInUserId = (): string | null => userId || null;
      req.getAccessToken = async (): Promise<string | null> =>
        token === '' ? null : token;
      return next();
    } catch (err: any) {
      return authErrorHandler(err, req, res, next);
    }
  };
