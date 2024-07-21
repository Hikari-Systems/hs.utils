import nconf from 'nconf';

const config = nconf
  .argv()
  .env('__')
  .file('secrets', '/run/secrets/config.json')
  .file('environment', '/sandbox/config.json')
  .file('defaults', 'config.json');

export default config;
