import express from 'express';
import dayjs from 'dayjs';

import logging from './logging';
import { LocalNextFunction, LocalRequest, LocalResponse } from './types';
import { forwardedFor } from './forwardedFor';
import { PostLoginAction, runPostLoginActions } from './postLoginActions';
import {
  DEFAULT_ERROR_HANDLER,
  Oauth2PathConfig,
  RedirectStore,
  TokenResponse,
  doAuthorizeRedirect,
  doTokenExchange,
  doTokenRefresh,
  getOauthProfileByToken,
  getSessionRedirectStore,
} from './oauth2';
import {
  KratosSessionResolver,
  KratosSessionUser,
  createKratosSessionResolver,
} from './kratos/sessionResolver';

const log = logging('middleware:authentication-kratos');

type ERROR_HANDLER_TYPE = (
  err: Error,
  req: LocalRequest,
  res: LocalResponse,
  next: LocalNextFunction,
) => Promise<void>;

export type AuthorizeKratosMiddlewareProps = {
  pathConfigs: Oauth2PathConfig[];
  // Resolver that turns the Hydra userinfo response into
  // { sub, profile }. Use `createKratosSessionResolver` for the standard
  // impl; pass your own for custom claim layouts. The Kratos identity ID
  // (= JWT sub) is used as the session userId — no UDS upsert.
  kratosResolver: KratosSessionResolver;
  stateStore?: RedirectStore;
  callbackErrorHandler?: ERROR_HANDLER_TYPE;
  callbackUri?: string;
  // Side-effects to run after each successful login (default tool server
  // provisioning, audit logs, welcome emails, etc.). Errors are logged
  // and swallowed.
  postLoginActions?: PostLoginAction[];
};

const writeSessionFromTokenResponse = (
  req: LocalRequest,
  user: KratosSessionUser,
  tokenResp: TokenResponse,
): void => {
  req.session.user = {
    userId: user.sub,
    accessToken: tokenResp.access_token,
    refreshToken: tokenResp?.refresh_token,
    // Stash id_token so apps can hand it to Hydra's RP-initiated logout
    // endpoint as `id_token_hint`. Hydra v2+ rejects logout requests that
    // pair `post_logout_redirect_uri` with a missing hint.
    idToken: tokenResp?.id_token ?? null,
    expiresAt: tokenResp?.expires_in
      ? dayjs().add(tokenResp.expires_in, 'second')
      : null,
    profile: user.profile,
  };
};

// Cookie-session OAuth middleware that uses Kratos as the source of truth
// for user details. After the OAuth dance it:
//  1. fetches userinfo from Hydra
//  2. asks the supplied `kratosResolver` to derive { sub, profile }
//     (primary path: namespaced claims; fallback: Kratos admin lookup)
//  3. stores `req.session.user = { userId: sub, profile, …tokens }`
//  4. fires post-login actions (idempotent side-effects)
//
// No UDS callbacks. No oauth_profile rows. The Kratos identity ID is the
// canonical user ID throughout the consuming app.
export const authorizeKratosMiddleware = ({
  pathConfigs,
  kratosResolver,
  stateStore = getSessionRedirectStore(),
  callbackErrorHandler = DEFAULT_ERROR_HANDLER(400),
  callbackUri = '/oauth2/callback',
  postLoginActions,
}: AuthorizeKratosMiddlewareProps) => {
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
        `Kratos authorization callback: code=${code} state=${stateKey}${error ? ' error=' : ''}${error || ''}`,
      );
      try {
        if (error) {
          throw new Error(error);
        }
        if (!code) {
          throw new Error('No code supplied');
        }
        const redirectUri = await stateStore.get(req, stateKey);
        if (!redirectUri) {
          throw new Error(`No state found: key=${stateKey}`);
        }

        const tokenResp = await doTokenExchange(
          code,
          `${baseUrl}${callbackUri}`,
        );
        if (!tokenResp?.access_token) {
          throw new Error('No access token in response');
        }
        await stateStore.del(req, stateKey);

        const dlProfile = await getOauthProfileByToken(tokenResp.access_token);
        const resolved = await kratosResolver.resolveFromProfile(dlProfile);
        if (!resolved) {
          throw new Error(
            `Kratos resolver returned no user for sub=${dlProfile.sub}`,
          );
        }

        await runPostLoginActions(postLoginActions, {
          accessToken: tokenResp.access_token,
          profile: dlProfile,
          userId: resolved.sub,
        });

        writeSessionFromTokenResponse(req, resolved, tokenResp);

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
      req.getLoggedInUserProfile = () => {
        const user = req?.session?.user;
        return user?.profile ?? null;
      };
      req.getAccessToken = async (): Promise<string | null> => {
        const user = req?.session?.user;
        if (!user) return null;
        if (
          !user.accessToken ||
          (user.expiresAt && user.expiresAt.isBefore(dayjs()))
        ) {
          if (user.refreshToken) {
            const tokenResp = await doTokenRefresh(user.refreshToken);
            req.session.user = {
              ...user,
              accessToken: tokenResp.access_token,
              refreshToken: tokenResp?.refresh_token,
              expiresAt: tokenResp?.expires_in
                ? dayjs().add(tokenResp.expires_in, 'second')
                : null,
            };
            return tokenResp.access_token || null;
          }
          req.session.user = {
            ...user,
            accessToken: null,
            refreshToken: null,
            expiresAt: null,
          };
          return null;
        }
        return user.accessToken || null;
      };
      if (matchedPath.whitelist) {
        return next();
      }
      const userId = req.getLoggedInUserId();
      if (matchedPath?.failFast) {
        if (!userId) {
          log.debug(`Auth: rejecting, not logged in on failfast path ${path}`);
          return res.status(401).send('not logged in');
        }
        return next();
      }
      if (userId) {
        return next();
      }
      return doAuthorizeRedirect(req.url, req, res, stateStore, callbackUri);
    },
  );
  return router;
};

export {
  // Re-export so consumers don't need to dig into ./kratos/* directly.
  createKratosSessionResolver,
};
