import { Dayjs } from 'dayjs';
import {
  Request as ESRequest,
  Response as ESResponse,
  NextFunction,
} from 'express-serve-static-core';
import { SessionData as ESSessionData, Session } from 'express-session';

export interface User {
  userId: string;
  accessToken: string | null;
  refreshToken?: string | null;
  expiresAt: Dayjs | null;
}

declare module 'express-session' {
  export interface SessionData {
    user: User;
  }
}

type LoggedInUserFunction = () => string | null;
type GetTokenFunction = () => Promise<string | null>;

export type LocalRequest = ESRequest;
export type LocalResponse = ESResponse;
export type LocalNextFunction = NextFunction;

declare module 'express-serve-static-core' {
  export interface Request {
    session: Session & Partial<ESSessionData>;
    getLoggedInUserId: LoggedInUserFunction;
    getAccessToken: GetTokenFunction;
  }
}
