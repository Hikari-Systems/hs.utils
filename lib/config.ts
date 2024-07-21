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

export default { get }; // export a wrapped nconf.get()
