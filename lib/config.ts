import nconf from 'nconf';

const config = nconf
  .argv()
  .env('__')
  .file('environment', '/sandbox/config.json')
  .file('defaults', 'config.json');

export default config;
