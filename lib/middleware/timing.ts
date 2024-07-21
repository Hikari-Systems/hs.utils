import config from '../config';
import logging from '../logging';
import { LocalNextFunction, LocalRequest, LocalResponse } from '../types';

const log = logging('server:timing');

const showCookies =
  (config.get('log:timing:showCookies') || 'false') === 'true';

export const timingMiddleware = (
  req: LocalRequest,
  res: LocalResponse,
  next: LocalNextFunction,
) => {
  const { cookie } = req.headers;
  const cookieMsg =
    showCookies && cookie && cookie !== '' ? ` cookie=${cookie}` : '';
  log.debug(`STARTED: ${req.method} ${req.originalUrl}${cookieMsg}`);
  const started = new Date();
  res.on('finish', () => {
    const duration = new Date().getTime() - started.getTime();
    log.debug(`COMPLETED in ${duration}ms: ${req.method} ${req.originalUrl}`);
  });
  return next();
};
