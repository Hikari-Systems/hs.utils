import { createLogger, format, transports } from 'winston';
import config from './config';

const level = config.get('log:level') || 'info';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const logging = (_name: string) =>
  createLogger({
    level,
    format: format.simple(),
    transports: [new transports.Console()],
  });

export default logging;
