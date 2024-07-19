import express from 'express';
import dayjs from 'dayjs';
import { v4 } from 'uuid';

import config from './config';
import logging from './logging';
import { delRedisVal, getRedisVal, setRedisVal } from './redis';
import { LocalNextFunction, LocalRequest, LocalResponse } from './types';
import { forwardedFor } from './forwardedFor';

const log = logging('middleware:authentication');

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
  id_token: string;
  nonce?: string;
};

type OauthProfile = {
  sub: string;
  given_name?: string;
  family_name?: string;
  name?: string;
  email?: string;
  email_verified?: boolean;
  nickname?: string;
  picture?: string;
  updated_at?: string;
};

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

const getOauthProfileByToken = async (token: string): Promise<OauthProfile> => {
  try {
    const response = await fetch(config.get('oauth2:profileUrl'), {
      headers: {
        'Content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    const profileResponse = await response.text();
    log.debug(`Profile is ${profileResponse}`);
    return JSON.parse(profileResponse) as OauthProfile;
  } catch (err) {
    log.error(`Error doing profile download: ${token}`, err);
    throw err;
  }
};

// ////////////////////////////

export type GetUserByEmailFunction<T> = (email: string) => Promise<T | null>;
export type AddUserByEmailFunction<T> = (email: string) => Promise<T>;
export type GetOauthProfileBySubFunction<U> = (
  sub: string,
) => Promise<U | null>;
export type UpsertOauthProfileFunction<U> = (
  sub: string,
  userId: string,
  profileJson: string,
) => Promise<U>;

export interface UserBaseType {
  id: string;
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

const DEFAULT_ERROR_HANDLER =
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
  callbackErrorHandler = DEFAULT_ERROR_HANDLER(400),
) => {
  const router = express.Router();
  router.get(
    '/oauth2/callback',
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

        let userId;
        if (!dlProfile.email) {
          const savedProfile = await getOauthProfileBySub(dlProfile.sub);
          if (!savedProfile) {
            const user = await addUserByEmail('');
            userId = user.id;
          } else {
            userId = savedProfile.userId;
          }
        } else {
          let user = await getUserByEmail(dlProfile.email);
          if (!user) {
            user = await addUserByEmail(dlProfile.email);
          }
          userId = user.id;
        }

        await upsertOauthProfile(
          dlProfile.sub,
          userId,
          JSON.stringify(dlProfile),
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
      const matchedPath = pathConfigs?.find((x) => x.regex.test(req.path));
      if (!matchedPath) {
        return next(
          new Error(`ERROR: No matching auth path config found at ${req.path}`),
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
        log.debug(`Auth: allowing whitelisted path ${req.path}`);
        return next();
      }
      const userId = req.getLoggedInUserId();
      if (matchedPath?.failFast) {
        if (!userId) {
          log.debug(
            `Auth: rejecting, not logged in on failfast path ${req.path}`,
          );
          return res.status(401).send(`not logged in`);
        }
        return doAuthorizeRedirect(req.url, req, res);
      }
      if (userId) {
        log.debug(`Authentication check passed: ${req.path}`);
        return next();
      }
      return doAuthorizeRedirect(req.url, req, res);
    },
  );
  return router;
};

export const bearerMiddleware =
  <T extends UserBaseType>(
    pathConfigs: Oauth2PathConfig[],
    getUserByEmail: GetUserByEmailFunction<T>,
    authErrorHandler = DEFAULT_ERROR_HANDLER(401),
  ) =>
  async (req: LocalRequest, res: LocalResponse, next: LocalNextFunction) => {
    const matchedPath = pathConfigs?.find((x) => x.regex.test(req.path));
    if (!matchedPath) {
      return next(
        new Error(`ERROR: No matching auth path config found at ${req.path}`),
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
      const user: T | null = await (async () => {
        if ((token || '') === '') {
          return null; // must be whitelisted and not logged in
        }
        // Passing token to back end oauth-provider
        const dlProfile = await getOauthProfileByToken(token);
        if (!dlProfile?.email) {
          throw new Error(
            `No email in downloaded profile: ${JSON.stringify(dlProfile)}`,
          );
        }
        const dlUser = await getUserByEmail(dlProfile.email);
        if (!dlUser) {
          throw new Error(`No user found for email ${dlProfile.email}`);
        }
        log.debug(`Token valid. Found user id=${dlUser?.id}`);
        return dlUser;
      })();

      req.getLoggedInUserId = (): string | null => user?.id || null;
      req.getAccessToken = async (): Promise<string | null> =>
        token === '' ? null : token;
      return next();
    } catch (err: any) {
      return authErrorHandler(err, req, res, next);
    }
  };
