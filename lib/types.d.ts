import { Dayjs } from 'dayjs';
import {
  Request as ESRequest,
  Response as ESResponse,
  NextFunction,
} from 'express-serve-static-core';
import { SessionData as ESSessionData, Session } from 'express-session';

// Snapshot of the user's Kratos identity captured at login time and cached
// on the session. Populated by `authorizeKratosMiddleware`. Legacy
// `authorizeMiddleware` leaves it undefined.
export interface SessionProfile {
  email?: string;
  name?: string;
  pictureImageServiceId?: string;
  termsVersion?: string;
  termsAcceptedAt?: string;
}

export interface User {
  userId: string;
  accessToken: string | null;
  refreshToken?: string | null;
  expiresAt: Dayjs | null;
  // Kratos identity snapshot. Optional so legacy session payloads remain
  // compatible.
  profile?: SessionProfile;
}

declare module 'express-session' {
  export interface SessionData {
    user: User;
    postLoginRedirects: Record<string, string>;
  }
}

type LoggedInUserFunction = () => string | null;
type GetTokenFunction = () => Promise<string | null>;
type LoggedInUserProfileFunction = () => SessionProfile | null;

export type LocalRequest = ESRequest;
export type LocalResponse = ESResponse;
export type LocalNextFunction = NextFunction;

declare module 'express-serve-static-core' {
  export interface Request {
    session: Session & Partial<ESSessionData>;
    getLoggedInUserId: LoggedInUserFunction;
    getAccessToken: GetTokenFunction;
    // Returns the Kratos identity snapshot captured at login. Available on
    // any request that ran through `authorizeKratosMiddleware`. Returns
    // null when no user is logged in or the request ran through legacy
    // `authorizeMiddleware`.
    getLoggedInUserProfile: LoggedInUserProfileFunction;
  }
}
