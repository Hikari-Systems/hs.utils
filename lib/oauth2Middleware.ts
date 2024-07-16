import express from 'express';
import dayjs from 'dayjs';
import { v4 } from 'uuid';

import config from './config';
import logging from './logging';
import { getRedisVal, setRedisVal } from './redis';
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

const DEFAULT_ERROR_HANDLER =
  (statusCode: number): ERROR_HANDLER_TYPE =>
  (inErr, _inReq, inRes) => {
    log.error(`Error ${statusCode}: ${inErr}`);
    inRes.status(statusCode).send('Error');
    return Promise.resolve();
  };

export const authorizeMiddleware = <
  T extends UserBaseType,
  U extends OauthProfileType,
>(
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
      const { code, state, error } = req.query as {
        code?: string;
        state: string;
        error?: string;
      };
      const { baseUrl } = forwardedFor(req);
      log.debug(
        `Authorization callback: code=${code} state=${state} error=${error}`,
      );
      if (error) {
        return callbackErrorHandler(new Error(error), req, res, next);
      }
      if (!code) {
        return callbackErrorHandler(
          new Error('No code supplied'),
          req,
          res,
          next,
        );
      }
      try {
        const tokenResp = await doTokenExchange(
          code,
          `${baseUrl}/oauth2/callback`,
        );
        if (!tokenResp?.access_token) {
          throw new Error(`No access token in response`);
        }
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
        const origUrl = (await getRedisVal(state)) || '/';
        log.debug(`Redirecting to ${origUrl}`);
        return res.redirect(origUrl);
      } catch (err: any) {
        return callbackErrorHandler(err, req, res, next);
      }
    },
  );

  router.use(
    async (req: LocalRequest, res: LocalResponse, next: LocalNextFunction) => {
      const { baseUrl } = forwardedFor(req);
      req.getLoggedInUserId = (): string | null => {
        const user = req.session?.user;
        return user?.userId || null;
      };
      req.getAccessToken = async (): Promise<string | null> => {
        const user = req.session?.user;
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
            return tokenResp.access_token;
          }
          req.session.user = {
            userId: user.userId,
            accessToken: null,
            refreshToken: null,
            expiresAt: null,
          };
          return null;
        }
        return user.accessToken;
      };

      if (req.getLoggedInUserId()) {
        log.debug(`Authentication check passed: ${req.url}`);
        return next();
      }
      const redirectUri = `${baseUrl}/oauth2/callback`;
      const stateKey = v4();
      await setRedisVal(stateKey, `${baseUrl}${req.url}`);
      const authorizeUrl = `${config.get('oauth2:authorizeUrl')}?response_type=code&client_id=${encodeURIComponent(
        config.get('oauth2:clientId'),
      )}&redirect_uri=${encodeURIComponent(
        redirectUri,
      )}&scope=${encodeURIComponent(
        config.get('oauth2:scopes'),
      )}&state=${encodeURIComponent(stateKey)}`;
      log.debug(
        `Unauthenticated request to ${req.url} ... authorizing at ${authorizeUrl}`,
      );
      return res.redirect(authorizeUrl);
    },
  );
  return router;
};

export const bearerMiddleware =
  <T extends UserBaseType>(
    getUserByEmail: GetUserByEmailFunction<T>,
    authErrorHandler = DEFAULT_ERROR_HANDLER(401),
  ) =>
  async (req: LocalRequest, res: LocalResponse, next: LocalNextFunction) => {
    const authHeader = req.headers?.authorization?.trim();
    if (!authHeader?.toLowerCase().startsWith('bearer ')) {
      return authErrorHandler(
        new Error(`No authorization header`),
        req,
        res,
        next,
      );
    }
    const token = authHeader.substring(7).trim();
    if (token === '') {
      return authErrorHandler(
        new Error(`No access token supplied`),
        req,
        res,
        next,
      );
    }
    try {
      // Passing token to back end oauth-provider
      const dlProfile = await getOauthProfileByToken(token);
      if (!dlProfile?.email) {
        throw new Error(`No email in dlProfile: ${JSON.stringify(dlProfile)}`);
      }
      const user = await getUserByEmail(dlProfile.email);
      if (!user) {
        throw new Error(`No user found for email ${dlProfile.email}`);
      }
      log.debug(`Token valid. Found user id=${user?.id}`);

      req.getLoggedInUserId = (): string | null => user?.id || null;
      req.getAccessToken = async (): Promise<string | null> => token;
      return next();
    } catch (err: any) {
      return authErrorHandler(err, req, res, next);
    }
  };
