import { createClient } from 'redis';
import config from './config';
import logging from './logging';

const log = logging('client:redis');

const getClient = () =>
  createClient({
    url: config.get('redis:url'),
    password: config.get('redis:auth') || undefined,
  });

export const getRedisVal = async (key: string): Promise<string | null> => {
  const redisConn = await getClient()
    .connect()
    .catch((err) => {
      log.error('Error in redis connection', err);
    });
  if (!redisConn) {
    return null;
  }
  try {
    const val = await redisConn.get(key);
    return val;
  } finally {
    redisConn?.disconnect();
  }
};

export const setRedisVal = async (
  key: string,
  value: string,
): Promise<void> => {
  const redisConn = await getClient()
    .connect()
    .catch((err) => {
      log.error('Error in redis connection', err);
    });
  if (!redisConn) {
    return;
  }
  try {
    await redisConn.set(key, value);
  } finally {
    redisConn?.disconnect();
  }
};

export const delRedisVal = async (key: string): Promise<void> => {
  const redisConn = await getClient()
    .connect()
    .catch((err) => {
      log.error('Error in redis connection', err);
    });
  if (!redisConn) {
    return;
  }
  try {
    await redisConn.del(key);
  } finally {
    redisConn?.disconnect();
  }
};

export const healthcheck = () =>
  new Promise<void>((resolve, reject) => {
    const testClient = getClient();
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
  });
