import config from './config';
import logging from './logging';
import { downloadAndStoreImage, ImageServiceClient } from './imageService';
import type { OauthProfileResponse } from './oauth2';
import { getUserById, updateUser } from './userDataService';

const log = logging('postLoginActions');

// What every post-login action receives. The same shape covers MCP bearer
// requests (token verified by hs.utils' MCP middleware), session-based
// oauth2 logins (the authorize callback), and per-request bearer-token
// auth (oauth2.bearerMiddleware) — so a single action can be wired into
// any of them.
export type PostLoginActionContext = {
  // The access token presented or obtained for this login.
  accessToken: string;
  // The OIDC profile (from /userinfo for session/bearer flows, or from
  // verified JWT claims for the MCP claims-resolver flow).
  profile: OauthProfileResponse;
  // The local user id (from user-data-service or equivalent).
  userId: string;
};

// A side-effect that runs after the user has been authenticated and their
// local user record has been resolved. Intended for image uploads, audit
// logs, role provisioning, welcome emails, etc. Actions should be
// idempotent and self-deduplicating, since they will fire on every
// authenticated request in the bearer/MCP flows unless they short-circuit
// themselves.
//
// Errors thrown from an action are logged and swallowed by
// `runPostLoginActions`, so a failing action will never block the request.
export type PostLoginAction = (ctx: PostLoginActionContext) => Promise<void>;

// Run a list of actions in parallel. Errors are logged with the action's
// index and swallowed.
export const runPostLoginActions = async (
  actions: PostLoginAction[] | undefined,
  ctx: PostLoginActionContext,
): Promise<void> => {
  if (!actions || actions.length === 0) return;
  await Promise.all(
    actions.map((action, i) =>
      action(ctx).catch((err) => {
        log.error(`post-login action[${i}] error: ${(err as Error).message}`);
      }),
    ),
  );
};

// ─── Picture upload action ──────────────────────────────────────────────

export type PictureUploadActionOptions = {
  // image-service connection. Defaults to config keys
  // `image-service:url` / `image-service:apiKey`.
  imageService?: ImageServiceClient;
  // What `type` to register the image under in image-service. Defaults to
  // 'userIcon' which matches the slackbot/botsafely conventions.
  imageType?: string;
  // Persist the uploaded picture's image-service ID + the originating URL
  // on the consumer's user record. Defaults to a read-modify-write through
  // user-data-service (`getUserById` + `updateUser`).
  setUserPicture?: (
    userId: string,
    pictureImageServiceId: string,
    pictureUrl: string,
  ) => Promise<void>;
};

const defaultImageService = (): ImageServiceClient => ({
  url: config.configString('image-service:url'),
  apiKey: config.configString('image-service:apiKey'),
});

const defaultSetUserPicture = async (
  userId: string,
  pictureImageServiceId: string,
  pictureUrl: string,
): Promise<void> => {
  const user = await getUserById(userId);
  if (!user) {
    throw new Error(`user-data-service has no user with id=${userId}`);
  }
  await updateUser({ ...user, picture: pictureUrl, pictureImageServiceId });
};

// Picture upload action. Downloads the OIDC profile picture, uploads it to
// image-service, and records the resulting image-service ID on the user
// record. With no arguments, image-service is reached via the
// `image-service:url` / `image-service:apiKey` config keys and the user
// record is updated through user-data-service. Self-caches by
// (userId, pictureUrl) so it only does the upload once per user per
// container lifetime, and retriggers automatically when the picture URL
// changes (e.g. after a Google avatar update).
export const createPictureUploadAction = (
  opts: PictureUploadActionOptions = {},
): PostLoginAction => {
  const seen = new Map<string, string>(); // userId -> last processed picture URL
  const imageType = opts.imageType ?? 'userIcon';
  const setUserPicture = opts.setUserPicture ?? defaultSetUserPicture;

  return async ({ userId, profile }) => {
    if (!profile.picture) return;
    if (seen.get(userId) === profile.picture) return;

    try {
      const imageService = opts.imageService ?? defaultImageService();
      const imageId = await downloadAndStoreImage(
        imageService,
        profile.picture,
        imageType,
      );
      await setUserPicture(userId, imageId, profile.picture);
      seen.set(userId, profile.picture);
      log.debug(`Stored ${imageType} imageId=${imageId} for userId=${userId}`);
    } catch (err) {
      log.error(
        `pictureUploadAction failed userId=${userId}: ${
          (err as Error).message
        }`,
      );
    }
  };
};
