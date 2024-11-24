import session, { Store } from 'express-session';
import RedisStore from 'connect-redis';
import connectPgSimple, { PGStore } from 'connect-pg-simple';
import { createClient } from 'redis';
import fs from 'fs';
import pg from 'pg';

import config from '../config';
import logging from '../logging';
import { LocalNextFunction, LocalRequest, LocalResponse } from './types';

const log = logging('middleware:session');

const configBoolean = (key: string, defaultValue = false): boolean =>
  (config.get(key) || String(defaultValue)).trim() === 'true';

const configInteger = (key: string, defaultValue: number): number =>
  config.get(key) ? parseInt(config.get(key), 10) : defaultValue;

const configString = (key: string, defaultValue = ''): string =>
  (config.get(key) || defaultValue).trim();

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

const sessionMiddleware =
  (storeGetter: StoreGetter) =>
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
    const store = await storeGetter();
    return session({ ...baseConfig, store })(req, res, next);
  };

// //////// REDIS IMPLEMENTATION - START
let redisStore: RedisStore | undefined;

const redisGetter: StoreGetter = async () => {
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

const getSslConfig = () => {
  if (!configBoolean('session:db:ssl:enabled')) {
    return false;
  }

  const rejectUnauthorized = configBoolean('session:db:ssl:verify');

  const caCertPath = configString('session:db:ssl:caCertFile');
  if (caCertPath === '') {
    return {
      rejectUnauthorized,
    };
  }
  return {
    rejectUnauthorized,
    ca: fs.readFileSync(caCertPath),
  };
};

const getConnectionPool = () =>
  new pg.Pool({
    user: configString('session:db:username', ''),
    password: configString('session:db:password', ''),
    database: configString('session:db:database', 'hs_session'),
    host: configString('session:db:host', ''),
    port: configInteger('session:db:port', 5432),
    min: configInteger('session:db:minpool', 0),
    max: configInteger('session:db:maxpool', 10),
    ssl: getSslConfig(),
  });

let pgSessionStore: PGStore | undefined;
const postgresGetter: StoreGetter = async () => {
  const url = (config.get('session:redis:url') || '').trim();
  if (url !== '') {
    if (!pgSessionStore) {
      pgSessionStore = new PGSession({
        pool: getConnectionPool(),
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

export const redisSessionMiddleware = sessionMiddleware(redisGetter);
export const postgresSessionMiddleware = sessionMiddleware(postgresGetter);
