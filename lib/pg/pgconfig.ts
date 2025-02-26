import pg from 'pg';
import fs from 'fs';
import config from '../config';

const { configString, configBoolean, configInteger } = config;

const getSslConfig = (prefix: string) => {
  if (!configBoolean(`${prefix}:ssl:enabled`)) {
    return false;
  }

  const rejectUnauthorized = configBoolean(`${prefix}:ssl:verify`);

  const caCertPath = configString(`${prefix}:ssl:caCertFile`);
  if (caCertPath === '') {
    return {
      rejectUnauthorized,
    };
  }
  return {
    rejectUnauthorized,
    ca: fs.readFileSync(caCertPath),
  };
};

export const getConnectionPoolFromConfigPrefix = (prefix: string) =>
  new pg.Pool({
    user: configString(`${prefix}:username`, ''),
    password: configString(`${prefix}:password`, ''),
    database: configString(`${prefix}:database`, 'hs_session'),
    host: configString(`${prefix}:host`, ''),
    port: configInteger(`${prefix}:port`, 5432),
    min: configInteger(`${prefix}:minpool`, 0),
    max: configInteger(`${prefix}:maxpool`, 3),
    ssl: getSslConfig(prefix),
  });
