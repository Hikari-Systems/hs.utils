import logging from './logging';
import { LocalNextFunction, LocalRequest, LocalResponse } from './types';

const log = logging('server:timing');

export const timingMiddleware = (
  req: LocalRequest,
  res: LocalResponse,
  next: LocalNextFunction,
) => {
  const { cookie } = req.headers;
  log.debug(
    `STARTED: ${req.method} ${req.originalUrl} ${cookie ? 'cookie=' : ''}${
      cookie || ''
    }`,
  );
  const started = new Date();
  res.on('finish', () => {
    const duration = new Date().getTime() - started.getTime();
    log.debug(`COMPLETED in ${duration}ms: ${req.method} ${req.originalUrl}`);
  });
  return next();
};
