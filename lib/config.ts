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

const getAllKeys = (): string[] => Object.keys(config.get());

const configString = (key: string, defaultValue = ''): string =>
  String(get(key) ?? defaultValue).trim();

const configInteger = (key: string, defaultValue = 0): number => {
  if (Number.isNaN(defaultValue) || !Number.isInteger(defaultValue)) {
    throw new Error(
      `Config "${key}": invalid default integer value "${defaultValue}"`,
    );
  }
  const raw = get(key);
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  const parsed = parseInt(String(raw).trim(), 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Config "${key}": invalid integer value "${raw}"`);
  }
  return parsed;
};

const configBoolean = (key: string, defaultValue = false): boolean => {
  if (typeof defaultValue !== 'boolean') {
    throw new Error(
      `Config "${key}": invalid default boolean value "${defaultValue}"`,
    );
  }
  const raw = get(key);
  if (raw === undefined || raw === null) return defaultValue;
  if (typeof raw === 'boolean') return raw;
  const s = String(raw).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off' || s === '')
    return false;
  throw new Error(`Config "${key}": invalid boolean value "${raw}"`);
};

const configFloat = (key: string, defaultValue = 0): number => {
  if (Number.isNaN(defaultValue)) {
    throw new Error(
      `Config "${key}": invalid default float value "${defaultValue}"`,
    );
  }
  const raw = get(key);
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  const parsed = parseFloat(String(raw).trim());
  if (Number.isNaN(parsed)) {
    throw new Error(`Config "${key}": invalid float value "${raw}"`);
  }
  return parsed;
};

export default {
  get,
  getAllKeys,
  configBoolean,
  configInteger,
  configString,
  configFloat,
}; // export a wrapped nconf.get()
