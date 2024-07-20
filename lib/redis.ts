import { createClient, RedisClientType } from 'redis';
import config from './config';
import logging from './logging';

const log = logging('client:redis');

const redisEnabled = (config.get('redis:enabled') || 'true') === 'true';
if (!redisEnabled) {
  log.warn('WARNING: Redis disabled in config (all lookups will return null)');
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

export const getRedisVal = async (key: string): Promise<string | null> => {
  const redisConn = await redisConnPromise;
  if (!redisConn) {
    return null;
  }
  try {
    return redisConn.get(key);
  } catch (err) {
    log.error(`Error in getRedisVal(${key})`, err);
    throw err;
  }
};

export const setRedisVal = async (
  key: string,
  value: string,
): Promise<void> => {
  const redisConn = await redisConnPromise;
  if (!redisConn) {
    return;
  }
  try {
    await redisConn.set(key, value);
  } catch (err) {
    log.error(`Error in setRedisVal(${key}, ${value})`, err);
    throw err;
  }
};

export const delRedisVal = async (key: string): Promise<void> => {
  const redisConn = await redisConnPromise;
  if (!redisConn) {
    return;
  }
  try {
    await redisConn.del(key);
  } catch (err) {
    log.error(`Error in delRedisVal(${key})`, err);
    throw err;
  }
};

export const healthcheck = () =>
  new Promise<void>((resolve, reject) => {
    const testClient = getClient();
    if (!testClient) {
      resolve();
    } else {
      const errorHandler = (err: Error) => {
        setTimeout(() => testClient?.disconnect(), 20);
        reject(new Error(`Redis health check failed: err=${err}`));
      };

      testClient.on('ready', () => {
        setTimeout(() => testClient?.disconnect(), 20);
        resolve();
      });
      testClient.on('error', errorHandler);
      testClient.connect().catch(errorHandler);
    }
  });
