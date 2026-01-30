# hs.utils

A comprehensive utility library for Node.js development projects at Hikari Systems. This library provides shared tools and middleware for authentication, session management, configuration, logging, database connections, and LangChain integration.

## Table of Contents

- [Installation](#installation)
- [Configuration](#configuration)
- [Components](#components)
  - [Config Management](#config-management)
  - [Logging](#logging)
  - [Forwarded For / Reverse Proxy](#forwarded-for--reverse-proxy)
  - [Middleware](#middleware)
    - [API Key Middleware](#api-key-middleware)
    - [Session Middleware](#session-middleware)
    - [Timing Middleware](#timing-middleware)
  - [Redis Client](#redis-client)
  - [OAuth2 Authentication](#oauth2-authentication)
  - [PostgreSQL Configuration](#postgresql-configuration)
  - [LangChain Integration](#langchain-integration)
- [Type Definitions](#type-definitions)
- [Examples](#examples)
- [License](#license)

## Installation

```bash
npm install @hikari-systems/hs.utils
```

## Configuration

This library uses `nconf` for configuration management with a hierarchical approach:

1. Command-line arguments (`argv()`)
2. Environment variables (with `__` separator, e.g., `server__apiKey`)
3. Environment-specific config file (`/sandbox/config.json`)
4. Default config file (`config.json`)

### Configuration Structure

Configuration keys use a colon-separated namespace format (e.g., `server:apiKey`, `session:secret`).

### Secret Management

For sensitive values, use the `[SECRET]:` prefix followed by a file path. The config system will read the secret from the specified file:

```json
{
  "oauth2:clientSecret": "[SECRET]:/path/to/secret/file"
}
```

## Components

### Config Management

**Location:** `lib/config.ts`

Provides a centralized configuration system with type-safe getters.

#### Methods

- `get(key: string)`: Get any configuration value (supports secret file reading)
- `getAllKeys()`: Get all configuration keys
- `configBoolean(key: string, defaultValue?: boolean)`: Get boolean config value
- `configInteger(key: string, defaultValue?: number)`: Get integer config value
- `configString(key: string, defaultValue?: string)`: Get string config value
- `configFloat(key: string, defaultValue?: number)`: Get float config value

#### Example

```typescript
import { config } from '@hikari-systems/hs.utils';

const apiKey = config.configString('server:apiKey', '');
const port = config.configInteger('server:port', 3000);
const enabled = config.configBoolean('feature:enabled', false);
```

### Logging

**Location:** `lib/logging.ts`

Winston-based logging factory function.

#### Usage

```typescript
import { logging } from '@hikari-systems/hs.utils';

const log = logging('module:name');
log.info('Information message');
log.debug('Debug message');
log.warn('Warning message');
log.error('Error message', error);
```

#### Configuration

- `log:level`: Logging level (default: `'info'`)

### Forwarded For / Reverse Proxy

**Location:** `lib/forwardedFor.ts`

Utility for handling reverse proxy headers and reconstructing URLs.

#### Function

- `forwardedFor(req: Request)`: Returns `{ baseUrl: string, fullUrl: string }`

#### Configuration

- `server:x-prefix`: Optional prefix for X-Forwarded-* headers (e.g., `'custom-'`)

#### Example

```typescript
import { forwardedFor } from '@hikari-systems/hs.utils';
import express from 'express';

const app = express();

app.get('/api/test', (req, res) => {
  const { baseUrl, fullUrl } = forwardedFor(req);
  // baseUrl: "https://example.com"
  // fullUrl: "https://example.com/api/test"
});
```

### Middleware

#### API Key Middleware

**Location:** `lib/middleware/apikey.ts`

Express middleware for API key authentication.

#### Configuration

- `server:apiKey`: API key to validate against

#### Usage

```typescript
import { apiKeyMiddleware } from '@hikari-systems/hs.utils';
import express from 'express';

const app = express();

// Protect routes with API key
app.use('/api', apiKeyMiddleware);

// Clients must include: X-Api-Key: <your-api-key>
```

#### Behavior

- If `server:apiKey` is not configured, all requests are allowed (with warning)
- Validates `X-Api-Key` header
- Returns 401 Unauthorized for invalid/missing keys

#### Session Middleware

**Location:** `lib/middleware/session.ts`

Express session middleware with support for multiple storage backends.

#### Store Getters

- `memoryStoreGetter`: In-memory store (default, not persistent)
- `redisStoreGetter`: Redis-backed session store
- `postgresStoreGetter`: PostgreSQL-backed session store

#### Configuration

**General Session:**
- `session:secret`: Session secret (required)
- `session:proxy`: Trust proxy (default: `true`)
- `session:resave`: Resave unmodified sessions (default: `false`)
- `session:saveUninitialized`: Save uninitialized sessions (default: `false`)
- `session:httpOnly`: HTTP-only cookies (default: `false`)
- `session:sameSite`: SameSite cookie policy (`'strict'`, `'lax'`, `'none'`, or `'true'` for strict)
- `session:secure`: Secure cookies (default: `false`)
- `session:signed`: Signed cookies (default: `false`)

**Redis Store:**
- `session:redis:url`: Redis connection URL
- `session:redis:auth`: Redis password (optional)
- `session:prefix`: Key prefix for session keys

**PostgreSQL Store:**
- `session:db:host`: Database host
- `session:db:port`: Database port (default: `5432`)
- `session:db:database`: Database name (default: `hs_session`)
- `session:db:username`: Database username
- `session:db:password`: Database password
- `session:db:tableName`: Session table name (default: `session`)
- `session:db:minpool`: Minimum pool size (default: `0`)
- `session:db:maxpool`: Maximum pool size (default: `3`)
- `session:db:ssl:enabled`: Enable SSL (default: `false`)
- `session:db:ssl:verify`: Verify SSL certificate (default: `false`)
- `session:db:ssl:caCertFile`: Path to CA certificate file

#### Usage

```typescript
import { sessionMiddleware, redisStoreGetter } from '@hikari-systems/hs.utils';
import express from 'express';

const app = express();

// Using Redis store
app.use(sessionMiddleware(redisStoreGetter));

// Using PostgreSQL store
import { postgresStoreGetter } from '@hikari-systems/hs.utils';
app.use(sessionMiddleware(postgresStoreGetter));

// Using memory store (default)
app.use(sessionMiddleware());
```

#### PostgreSQL Setup

For PostgreSQL session storage, create the session table:

```sql
CREATE TABLE "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
)
WITH (OIDS=FALSE);

ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX "IDX_session_expire" ON "session" ("expire");
```

#### Timing Middleware

**Location:** `lib/middleware/timing.ts`

Express middleware for request timing and logging.

#### Configuration

- `log:timing:showCookies`: Include cookies in log output (default: `false`)

#### Usage

```typescript
import { timingMiddleware } from '@hikari-systems/hs.utils';
import express from 'express';

const app = express();

app.use(timingMiddleware);
// Logs: STARTED: GET /api/users
// Logs: COMPLETED in 123ms: GET /api/users
```

### Redis Client

**Location:** `lib/redis.ts`

Redis client wrapper with connection management.

#### Functions

- `getRedisVal(key: string)`: Get value from Redis
- `setRedisVal(key: string, value: string)`: Set value in Redis
- `delRedisVal(key: string)`: Delete key from Redis
- `healthcheck()`: Health check function (returns Promise)

#### Configuration

- `redis:enabled`: Enable Redis (default: `true`)
- `redis:url`: Redis connection URL
- `redis:auth`: Redis password (optional)

#### Usage

```typescript
import { getRedisVal, setRedisVal, delRedisVal } from '@hikari-systems/hs.utils';

// Get value
const value = await getRedisVal('my:key');

// Set value
await setRedisVal('my:key', 'my-value');

// Delete key
await delRedisVal('my:key');
```

#### Behavior

- Returns `null` if Redis is disabled or connection fails
- Automatically manages connection lifecycle
- Logs connection events (ready, error, reconnecting, end)

### OAuth2 Authentication

**Location:** `lib/oauth2.ts`

Complete OAuth2 authentication middleware with session-based and bearer token support.

#### Types

- `Oauth2PathConfig`: Path configuration for authentication
- `GetUserByEmailFunction<U>`: Function to get user by email
- `AddUserByEmailFunction<U>`: Function to add user by email
- `GetOauthProfileBySubFunction<O>`: Function to get OAuth profile by subject
- `UpsertOauthProfileFunction<O>`: Function to upsert OAuth profile
- `UpdateUserFromOauthProfileFunction<U, O>`: Optional function to update user from profile
- `RedirectStore`: Interface for storing redirect URLs
- `OauthProfileResponse`: OAuth profile response structure
- `UserBaseType`: Base user type interface
- `OauthProfileType`: OAuth profile type interface

#### Configuration

- `oauth2:authorizeUrl`: OAuth2 authorization URL
- `oauth2:tokenUrl`: OAuth2 token exchange URL
- `oauth2:profileUrl`: OAuth2 user profile URL
- `oauth2:clientId`: OAuth2 client ID
- `oauth2:clientSecret`: OAuth2 client secret
- `oauth2:scopes`: OAuth2 scopes (space-separated)

#### Functions

- `authorizeMiddleware<T, U>(props)`: Session-based OAuth2 middleware
- `bearerMiddleware<T, U>(props)`: Bearer token OAuth2 middleware
- `getSessionRedirectStore()`: Default redirect store using session
- `doAuthorizeRedirect(path, req, res, redirectStore, callbackUri?)`: Manual redirect helper
- `DEFAULT_ERROR_HANDLER(statusCode)`: Default error handler factory

#### Path Configuration

```typescript
const pathConfigs: Oauth2PathConfig[] = [
  {
    regex: /^\/api\/public/,
    whitelist: true,  // Allow without authentication
    failFast: false   // Redirect to login instead of 401
  },
  {
    regex: /^\/api\/protected/,
    whitelist: false, // Require authentication
    failFast: true    // Return 401 immediately if not logged in
  }
];
```

#### Usage: Session-Based Authentication

```typescript
import { authorizeMiddleware, getSessionRedirectStore } from '@hikari-systems/hs.utils';
import express from 'express';

const app = express();

// Implement your data layer functions
const getUserByEmail = async (email: string) => { /* ... */ };
const addUserByEmail = async (email: string, profile: OauthProfileResponse) => { /* ... */ };
const getOauthProfileBySub = async (sub: string) => { /* ... */ };
const upsertOauthProfile = async (sub: string, userId: string, profileJson: string) => { /* ... */ };

app.use(authorizeMiddleware({
  pathConfigs: [
    { regex: /^\/api/, whitelist: false, failFast: false }
  ],
  getUserByEmail,
  addUserByEmail,
  getOauthProfileBySub,
  upsertOauthProfile,
  stateStore: getSessionRedirectStore(),
  callbackUri: '/oauth2/callback'
}));

// Access user ID in routes
app.get('/api/user', (req, res) => {
  const userId = req.getLoggedInUserId();
  const token = await req.getAccessToken();
});
```

#### Usage: Bearer Token Authentication

```typescript
import { bearerMiddleware } from '@hikari-systems/hs.utils';
import express from 'express';

const app = express();

app.use(bearerMiddleware({
  pathConfigs: [
    { regex: /^\/api/, whitelist: false, failFast: false }
  ],
  getUserByEmail,
  addUserByEmail,
  getOauthProfileBySub,
  upsertOauthProfile,
  authErrorHandler: DEFAULT_ERROR_HANDLER(401)
}));

// Clients must include: Authorization: Bearer <token>
```

#### Request Extensions

Both middleware add methods to the Express request object:

- `req.getLoggedInUserId()`: Get current user ID (returns `string | null`)
- `req.getAccessToken()`: Get access token (returns `Promise<string | null>`)

#### Session Data

Session-based authentication stores user data in `req.session.user`:

```typescript
{
  userId: string;
  accessToken: string | null;
  refreshToken?: string | null;
  expiresAt: Dayjs | null;
}
```

### PostgreSQL Configuration

**Location:** `lib/pg/pgconfig.ts`

PostgreSQL connection pool factory with SSL support.

#### Function

- `getConnectionPoolFromConfigPrefix(prefix: string)`: Create connection pool from config prefix

#### Configuration

For a prefix like `db:`, configure:

- `{prefix}:host`: Database host
- `{prefix}:port`: Database port (default: `5432`)
- `{prefix}:database`: Database name
- `{prefix}:username`: Database username
- `{prefix}:password`: Database password
- `{prefix}:minpool`: Minimum pool size (default: `0`)
- `{prefix}:maxpool`: Maximum pool size (default: `3`)
- `{prefix}:ssl:enabled`: Enable SSL (default: `false`)
- `{prefix}:ssl:verify`: Verify SSL certificate (default: `false`)
- `{prefix}:ssl:caCertFile`: Path to CA certificate file

#### Usage

```typescript
import { getConnectionPoolFromConfigPrefix } from '@hikari-systems/hs.utils';

const pool = getConnectionPoolFromConfigPrefix('db');
const result = await pool.query('SELECT * FROM users');
```

### LangChain Integration

**Location:** `lib/langchain/`

LangChain integration for conversational AI with checkpointing and streaming support.

#### Components

##### ChatHSTogetherAI

**Location:** `lib/langchain/chat-together.ts`

Custom LangChain chat model for Together AI.

#### Usage

```typescript
import { ChatHSTogetherAI } from '@hikari-systems/hs.utils';

const llm = new ChatHSTogetherAI({
  model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  apiKey: 'your-api-key'
});
```

##### Stream Functions

**Location:** `lib/langchain/stream.ts`

Functions for creating and serving LangGraph-based conversational agents.

#### Functions

- `getModel()`: Get configured LLM model (OpenAI, Together AI, or Bedrock)
- `getCheckpointSaver()`: Get checkpoint saver (PostgreSQL or Memory)
- `convertToLangchainTool(def: ToolDef)`: Convert tool definition to LangChain tool
- `llmResponseForConversation(evt, llm, promptText, toolset, threadId, thisInputText)`: Generate response with tools
- `serveResponseFromGraph(evt, graph, threadId, thisInputText)`: Serve response from compiled graph

#### Configuration

**LLM General:**
- `llm:type`: LLM provider (`'openAI'`, `'togetherAI'`, or `'bedrock'`)
- `llm:modelName`: Model name
- `llm:apiKey`: API key
- `llm:streaming`: Enable streaming (default: `false`)

**OpenAI:**
- `llm:baseUrl`: Custom base URL (optional)

**Together AI:**
- Uses `llm:apiKey` and `llm:modelName`

**AWS Bedrock:**
- `llm:bedrock:modelRegion`: AWS region
- `llm:bedrock:awsAccessKeyId`: AWS access key ID
- `llm:bedrock:awsSecretAccessKey`: AWS secret access key
- `llm:bedrock:temperature`: Temperature (default: `0.5`)

**Checkpointer:**
- `llm:checkpointer:db:host`: PostgreSQL host for checkpointer
- `llm:checkpointer:db:port`: PostgreSQL port (default: `5432`)
- `llm:checkpointer:db:database`: Database name
- `llm:checkpointer:db:username`: Database username
- `llm:checkpointer:db:password`: Database password
- `llm:checkpointer:db:minpool`: Minimum pool size (default: `0`)
- `llm:checkpointer:db:maxpool`: Maximum pool size (default: `3`)
- `llm:checkpointer:db:ssl:enabled`: Enable SSL (default: `false`)
- `llm:checkpointer:db:ssl:verify`: Verify SSL certificate (default: `false`)
- `llm:checkpointer:db:ssl:caCertFile`: Path to CA certificate file

**Important:** When setting up PostgreSQL checkpointer database, always grant schema creation rights:

```sql
GRANT CREATE ON DATABASE "checkpointer-db" TO "checkpointer-user";
```

The setup function needs create schema rights for some operations.

#### Types

**Location:** `lib/langchain/types.ts`

- `ToolDef`: Tool definition interface
- `ToolArgumentDef`: Tool argument definition interface

#### Example

```typescript
import {
  llmResponseForConversation,
  getModel,
  ToolDef
} from '@hikari-systems/hs.utils';
import { EventEmitter } from 'stream';

const evt = new EventEmitter();

const tools: ToolDef[] = [
  {
    name: 'get_weather',
    description: 'Get weather for a location',
    argDefs: [
      {
        name: 'location',
        type: 'string',
        description: 'City name',
        required: true
      }
    ],
    callable: async ({ location }) => {
      // Implement weather lookup
      return `Weather in ${location}: Sunny, 72°F`;
    }
  }
];

evt.on('start', ({ runId }) => {
  console.log('Started:', runId);
});

evt.on('llmToken', ({ token }) => {
  process.stdout.write(token);
});

evt.on('finish', ({ output }) => {
  console.log('\nFinished:', output);
});

evt.on('error', ({ message }) => {
  console.error('Error:', message);
});

const llm = await getModel();
await llmResponseForConversation(
  evt,
  llm,
  'You are a helpful assistant.',
  tools,
  'thread-123',
  'What is the weather in San Francisco?'
);
```

## Type Definitions

**Location:** `lib/types.d.ts`

### Extended Express Types

The library extends Express types with:

- `req.session.user`: User session data
- `req.getLoggedInUserId()`: Get logged-in user ID
- `req.getAccessToken()`: Get access token

### User Interface

```typescript
interface User {
  userId: string;
  accessToken: string | null;
  refreshToken?: string | null;
  expiresAt: Dayjs | null;
}
```

## Examples

### Complete Express App Setup

```typescript
import express from 'express';
import {
  config,
  logging,
  sessionMiddleware,
  redisStoreGetter,
  apiKeyMiddleware,
  timingMiddleware,
  authorizeMiddleware,
  getSessionRedirectStore
} from '@hikari-systems/hs.utils';

const app = express();
const log = logging('app');

// Timing middleware
app.use(timingMiddleware);

// Session middleware
app.use(sessionMiddleware(redisStoreGetter));

// OAuth2 authentication
app.use(authorizeMiddleware({
  pathConfigs: [
    { regex: /^\/api\/public/, whitelist: true, failFast: false },
    { regex: /^\/api/, whitelist: false, failFast: false }
  ],
  getUserByEmail: async (email) => { /* ... */ },
  addUserByEmail: async (email, profile) => { /* ... */ },
  getOauthProfileBySub: async (sub) => { /* ... */ },
  upsertOauthProfile: async (sub, userId, profileJson) => { /* ... */ },
  stateStore: getSessionRedirectStore()
}));

// API key middleware for internal APIs
app.use('/api/internal', apiKeyMiddleware);

// Routes
app.get('/api/user', (req, res) => {
  const userId = req.getLoggedInUserId();
  res.json({ userId });
});

const port = config.configInteger('server:port', 3000);
app.listen(port, () => {
  log.info(`Server listening on port ${port}`);
});
```

## License

Apache 2.0 License. See LICENSE.txt for details.
