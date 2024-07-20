import session from 'express-session';
import RedisStore from 'connect-redis';
import { createClient, RedisClientType } from 'redis';
import config from '../config';
import logging from '../logging';
import { LocalNextFunction, LocalRequest, LocalResponse } from '../types';

const log = logging('middelware:session');

const redisClient = createClient({
  url: config.get('redis:url'),
  password: config.get('redis:auth') || undefined,
});

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
const redisConnPromise: Promise<RedisClientType<any, any, any>> =
  redisClient.connect();

export const sessionMiddleware = async (
  req: LocalRequest,
  res: LocalResponse,
  next: LocalNextFunction,
) => {
  const sameSite = config.get('session:sameSite') || '';
  const redisConn = await redisConnPromise;
  return session({
    store: new RedisStore({
      client: redisConn,
      prefix: config.get('session:prefix') || '',
    }),
    secret: config.get('session:secret') || '',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: config.get('session:httpOnly') === 'true' ? true : undefined,
      sameSite: sameSite === '' ? undefined : sameSite,
      secure: config.get('session:secure') === 'true' ? true : undefined,
      signed: config.get('session:signed') === 'true' ? true : undefined,
    },
  })(req, res, next);
};
