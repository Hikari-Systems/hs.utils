import session, { MemoryStore, Store } from 'express-session';
import RedisStore from 'connect-redis';
import connectPgSimple, { PGStore } from 'connect-pg-simple';
import { createClient } from 'redis';

import config from '../config';
import logging from '../logging';
import { LocalNextFunction, LocalRequest, LocalResponse } from '../types';
import { getConnectionPoolFromConfigPrefix } from '../pg/pgconfig';

const log = logging('middleware:session');

const { configString, configBoolean } = config;

const getSameSite = () => {
  const sameSiteStr = configString('session:sameSite', '');
  switch (sameSiteStr) {
    case 'true':
      return 'strict';
    case 'strict':
    case 'lax':
    case 'none':
      return sameSiteStr;
    default:
      return undefined;
  }
};

type StoreGetter = () => Promise<Store | undefined>;
const memoryStore = new MemoryStore();
const memoryStoreGetter: StoreGetter = () => Promise.resolve(memoryStore);

export const sessionMiddleware =
  (storeGetter: StoreGetter = memoryStoreGetter) =>
  async (req: LocalRequest, res: LocalResponse, next: LocalNextFunction) => {
    const baseConfig: session.SessionOptions = {
      secret: configString('session:secret', ''),
      proxy: configBoolean('session:proxy', true),
      resave: configBoolean('session:resave', false),
      saveUninitialized: configBoolean('session:saveUninitialized', false),
      cookie: {
        httpOnly: configBoolean('session:httpOnly', false) || undefined,
        sameSite: getSameSite(),
        secure: configBoolean('session:secure', false) || undefined,
        signed: configBoolean('session:signed', false) || undefined,
      },
    };
    const store = (await storeGetter()) || (await memoryStoreGetter());
    return session({ ...baseConfig, store })(req, res, next);
  };

// //////// REDIS IMPLEMENTATION - START
let redisStore: RedisStore | undefined;

export const redisStoreGetter: StoreGetter = async () => {
  const url = configString('session:redis:url', '').trim();
  if (url !== '') {
    if (!redisStore) {
      const redisClient = createClient({
        url,
        password: configString('session:redis:auth', undefined),
      });
      redisClient.on('ready', () => {
        log.debug('Session redis connection available');
      });
      redisClient.on('error', (e) => {
        log.error('Error in session redis connection', e);
      });
      redisClient.on('reconnecting', () => {
        log.debug('Session redis connection interrupted - reconnecting');
      });
      redisClient.on('end', () => {
        log.debug('Session redis connection is disconnected');
      });
      const redisConn = await redisClient.connect();
      redisStore = new RedisStore({
        client: redisConn,
        prefix: configString('session:prefix', ''),
      });
    }

    if (redisStore) {
      return redisStore;
    }
  }
  log.warn(
    'WARNING: Redis session configuration missing: using in memory session store',
  );
  return undefined;
};
// //////// REDIS IMPLEMENTATION - END

// //////// POSTGRES IMPLEMENTATION - START
const PGSession = connectPgSimple(session);

let pgSessionStore: PGStore | undefined;
export const postgresStoreGetter: StoreGetter = async () => {
  const host = (config.get('session:db:host') || '').trim();
  if (host !== '') {
    if (!pgSessionStore) {
      pgSessionStore = new PGSession({
        pool: getConnectionPoolFromConfigPrefix('session:db'),
        tableName: config.get('session:db:tableName') || 'session',
      });
    }

    if (pgSessionStore) {
      return pgSessionStore;
    }
  }
  log.warn(
    'WARNING: PostgreSQL session configuration missing: using in memory session store',
  );
  return undefined;
};
// //////// POSTGRES IMPLEMENTATION - END
