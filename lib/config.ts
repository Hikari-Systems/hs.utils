import nconf from 'nconf';
import { readFileSync } from 'fs';

const SECRET_PREFIX = '[SECRET]:';

const config = nconf
  .argv()
  .env('__')
  .file('environment', '/sandbox/config.json')
  .file('defaults', 'config.json');

const get = (key: string) => {
  const val = config.get(key);
  if (val && `${val}`.startsWith(SECRET_PREFIX)) {
    const filename = `${val}`.substring(SECRET_PREFIX.length);
    return readFileSync(filename, { encoding: 'utf-8', flag: 'r' });
  }
  return val;
};

const configBoolean = (key: string, defaultValue = false): boolean =>
  (config.get(key) || String(defaultValue)).trim() === 'true';

const configInteger = (key: string, defaultValue: number): number =>
  config.get(key) ? parseInt(config.get(key), 10) : defaultValue;

const configString = (key: string, defaultValue = ''): string =>
  (config.get(key) || defaultValue).trim();

export default { get, configBoolean, configInteger, configString }; // export a wrapped nconf.get()
