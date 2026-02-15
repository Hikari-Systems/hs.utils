import config from '../config';
import logging from '../logging';
import { LocalNextFunction, LocalRequest, LocalResponse } from '../types';

const { configString } = config;
const log = logging('middleware:apikey');

export const apiKeyMiddleware = (
  req: LocalRequest,
  res: LocalResponse,
  next: LocalNextFunction,
) => {
  const apiKey = configString('server:apiKey', '');
  if (apiKey === '') {
    log.warn('WARNING: server:apiKey is not set, allowing all requests');
    return next();
  }
  const { 'X-Api-Key': apiKeyHeader } = req.headers;
  if (apiKeyHeader !== apiKey) {
    return res.status(401).send('Unauthorized: invalid API key');
  }
  return next();
};
