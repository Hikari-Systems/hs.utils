import session from 'express-session';
import RedisStore from 'connect-redis';
import { createClient, RedisClientType } from 'redis';
import config from '../config';
import logging from '../logging';
import { LocalNextFunction, LocalRequest, LocalResponse } from '../types';

const log = logging('middelware:session');

const redisEnabled = (config.get('redis:enabled') || 'true') === 'true';
if (!redisEnabled) {
  log.warn(
    'WARNING: Redis disabled in config (sessions using default memory store)',
  );
}

const getClient = () => {
  if (redisEnabled) {
    return createClient({
      url: config.get('redis:url'),
      password: config.get('redis:auth') || undefined,
    });
  }
  return null;
};

// hold a promise in module scope, then await the same promise to get the resolved value
// before using it each time. Assumes these objects are shareable across requests (todo: verify)
const redisConnPromise: Promise<RedisClientType<any, any, any> | null> =
  (async () => {
    const redisClient = getClient();
    if (!redisClient) {
      return null;
    }
    redisClient.on('ready', () => {
      log.debug('Session store in redis connected');
    });
    redisClient.on('error', (e) => {
      log.error('Error in redis connection', e);
    });
    redisClient.on('reconnecting', () => {
      log.debug('Session store in redis reconnecting');
    });
    redisClient.on('end', () => {
      log.debug('Session store in redis disconnected');
    });
    return redisClient.connect();
  })();

export const sessionMiddleware = async (
  req: LocalRequest,
  res: LocalResponse,
  next: LocalNextFunction,
) => {
  const sameSite = config.get('session:sameSite') || '';
  const baseConfig = {
    secret: config.get('session:secret') || '',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: config.get('session:httpOnly') === 'true' ? true : undefined,
      sameSite: sameSite === '' ? undefined : sameSite,
      secure: config.get('session:secure') === 'true' ? true : undefined,
      signed: config.get('session:signed') === 'true' ? true : undefined,
    },
  };
  if (redisEnabled) {
    const redisConn = await redisConnPromise;
    return session({
      ...baseConfig,
      store: new RedisStore({
        client: redisConn,
        prefix: config.get('session:prefix') || '',
      }),
    })(req, res, next);
  }
  return session({
    ...baseConfig,
  })(req, res, next);
};
