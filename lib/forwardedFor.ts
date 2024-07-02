import { Request } from 'express-serve-static-core';
import config from './config';

export const forwardedFor = (req: Request) => {
  const protocol =
    req.headers[`x-${config.get('server:x-prefix') || ''}forwarded-proto`] ||
    req.protocol ||
    'http';

  // port determination: use default for protocol if not specified, then override with XFF if supplied
  const defaultPortForProtocol = protocol === 'https' ? '443' : '80';
  const port =
    req.headers[`x-${config.get('server:x-prefix') || ''}forwarded-port`] ||
    defaultPortForProtocol;

  const host =
    req.headers[`x-${config.get('server:x-prefix') || ''}forwarded-host`] ||
    req.headers.host ||
    '';

  // rebuild the url from component parts
  const isStandardPort =
    (protocol === 'https' && port === '443') ||
    (protocol === 'http' && port === '80');
  const portSuffix = isStandardPort ? '' : `:${port}`;
  return {
    baseUrl: `${protocol}://${host}${portSuffix}`,
    fullUrl: `${protocol}://${host}${portSuffix}${req.originalUrl}`,
  };
};

export default forwardedFor;
