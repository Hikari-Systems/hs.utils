import type { JWTPayload } from 'jose';

declare module 'express-serve-static-core' {
  interface Request {
    mcpAuthToken?: JWTPayload;
  }
}

export {};
