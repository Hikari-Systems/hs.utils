import { Request, Response, NextFunction } from 'express';

import logging from './logging';

const log = logging('server:timing');

export default (req: Request, res: Response, next: NextFunction) => {
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
