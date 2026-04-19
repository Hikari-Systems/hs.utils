import Redis from 'ioredis';
import config from './config';
import logging from './logging';

const log = logging('client:redis');

const getClient = (): Redis | null => {
  const redisEnabled = (config.get('redis:enabled') || 'true') === 'true';
  if (!redisEnabled) {
    log.warn(
      'WARNING: Redis disabled in config (all lookups will return null)',
    );
    return null;
  }
  const url = config.get('redis:url');
  const password = config.get('redis:auth') || undefined;
  return new Redis(url, { password });
};

// hold a promise in module scope, then await the same promise to get the resolved value
// before using it each time. Assumes these objects are shareable across requests (todo: verify)
let internalRedisConn: Redis | null;

const ensureRedisConnection = async () => {
  if (!internalRedisConn) {
    const redisClient = getClient();
    if (!redisClient) {
      internalRedisConn = null;
    } else {
      redisClient.on('ready', () => {
        log.debug('General purpose redis connection available');
      });
      redisClient.on('error', (e: Error) => {
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
      await redisClient.ping();
      internalRedisConn = redisClient;
    }
  }
  return internalRedisConn;
};

export const getRedisVal = async (key: string): Promise<string | null> => {
  const redisConn = await ensureRedisConnection();
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
  const redisConn = await ensureRedisConnection();
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
  const redisConn = await ensureRedisConnection();
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
    const redisEnabled = (config.get('redis:enabled') || 'true') === 'true';
    if (!redisEnabled) {
      resolve();
      return;
    }
    const url = config.get('redis:url');
    const password = config.get('redis:auth') || undefined;
    const testClient = new Redis(url, {
      password,
      lazyConnect: true,
    });

    const cleanup = () => {
      setTimeout(() => {
        testClient.disconnect();
      }, 20);
    };

    const errorHandler = (err: Error) => {
      cleanup();
      reject(new Error(`Redis health check failed: err=${err}`));
    };

    testClient.once('ready', () => {
      cleanup();
      resolve();
    });
    testClient.once('error', errorHandler);
    void testClient.connect().catch(errorHandler);
  });
