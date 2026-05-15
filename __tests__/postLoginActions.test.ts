import {
  createPictureUploadAction,
  PostLoginActionContext,
  runPostLoginActions,
} from '../lib/postLoginActions';

const buildCtx = (
  overrides: Partial<PostLoginActionContext> = {},
): PostLoginActionContext => ({
  accessToken: 't',
  userId: 'user-1',
  profile: {
    sub: 'sub-1',
    email: 'a@b.c',
    picture: 'https://cdn.example/pic1.png',
  },
  ...overrides,
});

describe('createPictureUploadAction', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('downloads, uploads to image-service, and calls setUserPicture', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'image-99' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const setUserPicture = jest.fn(async () => undefined);
    const action = createPictureUploadAction({
      imageService: { url: 'http://image-svc:3000', apiKey: 'k' },
      setUserPicture,
    });

    await action(buildCtx());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0][0] as string).toString()).toBe(
      'https://cdn.example/pic1.png',
    );
    expect((fetchMock.mock.calls[1][0] as string).toString()).toContain(
      '/api/image/userIcon',
    );
    expect(setUserPicture).toHaveBeenCalledWith(
      'user-1',
      'image-99',
      'https://cdn.example/pic1.png',
    );
  });

  it('skips re-upload when the same userId+pictureUrl is seen again', async () => {
    let call = 0;
    const fetchMock = jest.fn(async () => {
      call += 1;
      return call % 2 === 1
        ? new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'Content-Type': 'image/png' },
          })
        : new Response(JSON.stringify({ id: 'image-1' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const setUserPicture = jest.fn(async () => undefined);
    const action = createPictureUploadAction({
      imageService: { url: 'http://image-svc:3000', apiKey: 'k' },
      setUserPicture,
    });

    const ctx = buildCtx();
    await action(ctx);
    await action(ctx);
    await action(ctx);

    expect(setUserPicture).toHaveBeenCalledTimes(1);
  });

  it('re-uploads when the picture URL changes', async () => {
    let call = 0;
    const fetchMock = jest.fn(async () => {
      call += 1;
      return call % 2 === 1
        ? new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'Content-Type': 'image/png' },
          })
        : new Response(JSON.stringify({ id: 'image-x' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const setUserPicture = jest.fn(async () => undefined);
    const action = createPictureUploadAction({
      imageService: { url: 'http://image-svc:3000', apiKey: 'k' },
      setUserPicture,
    });

    await action(
      buildCtx({
        profile: { sub: 'sub-1', picture: 'https://cdn.example/pic1.png' },
      }),
    );
    await action(
      buildCtx({
        profile: { sub: 'sub-1', picture: 'https://cdn.example/pic2.png' },
      }),
    );

    expect(setUserPicture).toHaveBeenCalledTimes(2);
    expect(setUserPicture.mock.calls[0][2]).toBe(
      'https://cdn.example/pic1.png',
    );
    expect(setUserPicture.mock.calls[1][2]).toBe(
      'https://cdn.example/pic2.png',
    );
  });

  it('no-ops when profile has no picture', async () => {
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const setUserPicture = jest.fn(async () => undefined);
    const action = createPictureUploadAction({
      imageService: { url: 'http://image-svc:3000', apiKey: 'k' },
      setUserPicture,
    });

    await action(buildCtx({ profile: { sub: 'sub-1', email: 'a@b.c' } }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(setUserPicture).not.toHaveBeenCalled();
  });

  it('logs and swallows errors from the upload chain', async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(
        new Response('boom', { status: 500 }),
      ) as unknown as typeof fetch;

    const setUserPicture = jest.fn(async () => undefined);
    const action = createPictureUploadAction({
      imageService: { url: 'http://image-svc:3000', apiKey: 'k' },
      setUserPicture,
    });

    await expect(action(buildCtx())).resolves.toBeUndefined();
    expect(setUserPicture).not.toHaveBeenCalled();
  });
});

describe('runPostLoginActions', () => {
  it('runs all actions in parallel', async () => {
    const a = jest.fn(async () => undefined);
    const b = jest.fn(async () => undefined);
    await runPostLoginActions([a, b], buildCtx());
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('swallows individual action errors so others still run', async () => {
    const failing = jest.fn(async () => {
      throw new Error('boom');
    });
    const ok = jest.fn(async () => undefined);
    await expect(
      runPostLoginActions([failing, ok], buildCtx()),
    ).resolves.toBeUndefined();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for an empty or undefined list', async () => {
    await expect(runPostLoginActions(undefined, buildCtx())).resolves.toBeUndefined();
    await expect(runPostLoginActions([], buildCtx())).resolves.toBeUndefined();
  });
});
