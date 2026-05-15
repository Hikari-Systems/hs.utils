import {
  createOidcUserResolver,
  McpUserResolutionOptions,
} from '../../lib/mcp-auth/userResolution';
import {
  AddUserByEmailFunction,
  GetOauthProfileBySubFunction,
  GetUserByEmailFunction,
  OauthProfileType,
  UpsertOauthProfileFunction,
  UserBaseType,
} from '../../lib/oauth2';

type TestUser = UserBaseType & { id: string };
type TestProfile = OauthProfileType;

const buildOpts = (
  overrides: Partial<McpUserResolutionOptions<TestUser, TestProfile>> = {},
): McpUserResolutionOptions<TestUser, TestProfile> => {
  const getUserByEmail: GetUserByEmailFunction<TestUser> = jest.fn(
    async () => null,
  );
  const addUserByEmail: AddUserByEmailFunction<TestUser> = jest.fn(
    async (email) => ({ id: 'user-1', email }),
  );
  const getOauthProfileBySub: GetOauthProfileBySubFunction<TestProfile> =
    jest.fn(async () => null);
  const upsertOauthProfile: UpsertOauthProfileFunction<TestProfile> = jest.fn(
    async (sub, userId, profileJson) => ({
      sub,
      userId,
      profileJson: JSON.parse(profileJson),
    }),
  );

  return {
    authorizationServerUrl: 'https://as.example/',
    getUserByEmail,
    addUserByEmail,
    getOauthProfileBySub,
    upsertOauthProfile,
    ...overrides,
  };
};

describe('createOidcUserResolver', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('fetches /userinfo, upserts the user, and returns {userId, profile}', async () => {
    const fetchMock = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            sub: 'google-oauth2|abc',
            email: 'rick@example.com',
            name: 'Rick K',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const opts = buildOpts();
    const resolver = createOidcUserResolver(opts);

    const result = await resolver('the-token', { sub: 'google-oauth2|abc' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][0] as string).toString()).toBe(
      'https://as.example/userinfo',
    );
    expect(result).toEqual({
      userId: 'user-1',
      profile: expect.objectContaining({
        sub: 'google-oauth2|abc',
        email: 'rick@example.com',
      }),
    });
    expect(opts.addUserByEmail).toHaveBeenCalledWith(
      'rick@example.com',
      expect.objectContaining({ sub: 'google-oauth2|abc' }),
    );
    expect(opts.upsertOauthProfile).toHaveBeenCalledWith(
      'google-oauth2|abc',
      'user-1',
      expect.stringContaining('rick@example.com'),
    );
  });

  it('caches by sub for the configured TTL', async () => {
    const fetchMock = jest.fn(
      async () =>
        new Response(
          JSON.stringify({ sub: 'google-oauth2|abc', email: 'a@b.c' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const resolver = createOidcUserResolver(
      buildOpts({ profileCacheTtlMs: 60_000 }),
    );

    await resolver('t', { sub: 'google-oauth2|abc' });
    await resolver('t', { sub: 'google-oauth2|abc' });
    await resolver('t', { sub: 'google-oauth2|abc' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns undefined and logs when /userinfo errors', async () => {
    globalThis.fetch = jest.fn(
      async () => new Response('boom', { status: 500 }),
    ) as unknown as typeof fetch;

    const resolver = createOidcUserResolver(buildOpts());
    const result = await resolver('t', { sub: 'google-oauth2|x' });

    expect(result).toBeUndefined();
  });

  it('skips when JWT has no sub', async () => {
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const resolver = createOidcUserResolver(buildOpts());
    const result = await resolver('t', {});

    expect(result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
