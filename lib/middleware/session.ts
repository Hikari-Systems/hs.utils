import session, { Store } from 'express-session';
import RedisStore from 'connect-redis';
import { createClient, RedisClientType } from 'redis';

import config from '../config';
import logging from '../logging';
import { LocalNextFunction, LocalRequest, LocalResponse } from '../types';

const log = logging('middleware:session');

type StoreGetter = () => Promise<Store | undefined>;

const sessionMiddleware =
  (storeGetter: StoreGetter) =>
  async (req: LocalRequest, res: LocalResponse, next: LocalNextFunction) => {
    const sameSite = config.get('session:sameSite') || '';
    const baseConfig = {
      secret: config.get('session:secret') || '',
      proxy: (config.get('session:proxy') || 'true') === 'true',
      resave: (config.get('session:resave') || 'false') === 'true',
      saveUninitialized:
        (config.get('session:saveUninitialized') || 'false') === 'true',
      cookie: {
        httpOnly:
          (config.get('session:httpOnly') || 'false') === 'true'
            ? true
            : undefined,
        sameSite: sameSite === '' ? undefined : sameSite,
        secure:
          (config.get('session:secure') || 'false') === 'true'
            ? true
            : undefined,
        signed:
          (config.get('session:signed') || 'false') === 'true'
            ? true
            : undefined,
      },
    };
    const store = await storeGetter();
    return session({ ...baseConfig, store })(req, res, next);
  };

// //////// REDIS IMPLEMENTATION - START
let redisClientPromise: Promise<RedisClientType<any, any, any> | undefined>;

const redisGetter: StoreGetter = async () => {
  const url = (config.get('session:redis:url') || '').trim();
  if (url !== '') {
    if (redisClientPromise === undefined) {
      redisClientPromise = new Promise<RedisClientType<any, any, any>>(
        (resolve, reject) => {
          const redisClient = createClient({
            url,
            password: config.get('session:redis:auth') || undefined,
          });
          redisClient.on('ready', () => {
            log.debug('General purpose redis connection available');
          });
          redisClient.on('error', (e) => {
            log.error('Error in general purpose redis connection', e);
          });
          redisClient.on('reconnecting', () => {
            log.debug(
              'General purpose redis connection interrupted - reconnecting',
            );
          });
          redisClient.on('end', () => {
            log.debug('General purpose redis connection is disconnected');
          });
          redisClient.connect().then(resolve).catch(reject);
        },
      );
    }

    if (redisClientPromise) {
      const redisConn = await redisClientPromise;
      return new RedisStore({
        client: redisConn,
        prefix: config.get('session:prefix') || '',
      });
    }
  }
  log.warn(
    'WARNING: Redis session configuration missing: using in memory session store',
  );
  return undefined;
};
// //////// REDIS IMPLEMENTATION - END

// //////// POSTGRES IMPLEMENTATION - END
const postgresGetter: StoreGetter = async () => {
  if (clientPromise) {
    return new pgSession({
      pool: pgPool,                // Connection pool
      tableName: 'user_sessions'   // Use another table-name than the default "session" one
      // Insert connect-pg-simple options here
    }),
    new PgS({
      client: redisConn,
      prefix: config.get('session:prefix') || '',
    });
  }
  log.warn(
    'WARNING: PostgreSQL session configuration missing: using in memory session store',
  );
  return undefined;
};
// //////// POSTGRES IMPLEMENTATION - END

export const redisSessionMiddleware = sessionMiddleware(redisGetter);
export const postgresSessionMiddleware = sessionMiddleware(postgresGetter);
