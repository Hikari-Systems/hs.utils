import session, { MemoryStore, Store } from 'express-session';
import RedisStore from 'connect-redis';
import connectPgSimple, { PGStore } from 'connect-pg-simple';
import Redis from 'ioredis';

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

const parseSentinelHosts = (hosts: string) =>
  hosts.split(',').map((h) => {
    const [sentinelHost, portStr] = h.trim().split(':');
    return { host: sentinelHost, port: parseInt(portStr || '26379', 10) };
  });

export const redisStoreGetter: StoreGetter = async () => {
  const url = configString('session:redis:url', '').trim();
  const host = configString('session:redis:host', '').trim();
  const sentinelHosts = configString('session:redis:sentinel:hosts', '').trim();

  if (url !== '' || host !== '' || sentinelHosts !== '') {
    if (!redisStore) {
      const auth = configString('session:redis:auth', '').trim() || undefined;
      const username =
        configString('session:redis:username', '').trim() || undefined;
      const db = parseInt(configString('session:redis:db', '0'), 10) || 0;
      const prefix = configString('session:prefix', '');

      const ioClient =
        sentinelHosts !== ''
          ? new Redis({
              sentinels: parseSentinelHosts(sentinelHosts),
              name: configString(
                'session:redis:sentinel:masterName',
                'mymaster',
              ),
              db,
              ...(auth && { password: auth }),
              ...(username && { username }),
            })
          : url !== ''
            ? new Redis(url, { ...(auth && { password: auth }), db })
            : new Redis({
                host,
                port:
                  parseInt(configString('session:redis:port', '6379'), 10) ||
                  6379,
                db,
                ...(auth && { password: auth }),
                ...(username && { username }),
              });

      ioClient.on('ready', () => {
        log.debug('Session redis connection available');
      });
      ioClient.on('error', (e) => {
        log.error('Error in session redis connection', e);
      });
      ioClient.on('reconnecting', () => {
        log.debug('Session redis connection interrupted - reconnecting');
      });
      ioClient.on('end', () => {
        log.debug('Session redis connection is disconnected');
      });
      redisStore = new RedisStore({ client: ioClient as any, prefix });
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
