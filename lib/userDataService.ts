import config from './config';
import logging from './logging';
import type { OauthProfileResponse } from './oauth2';

const log = logging('userDataService');

const baseUrl = (): string => config.configString('user-data-service:url');
const apiKey = (): string => config.configString('user-data-service:apiKey');

export type User = {
  email: string;
  name?: string;
  picture?: string;
  pictureImageServiceId?: string;
};

export type OauthProfile = {
  sub: string;
  userId: string;
  profileJson: OauthProfileResponse;
};

const buildHeaders = (
  extra?: Record<string, string>,
): Record<string, string> => {
  const headers: Record<string, string> = {};
  const k = apiKey();
  if (k) headers['X-API-Key'] = k;
  if (extra) Object.assign(headers, extra);
  return headers;
};

const okOrNull = async (url: string): Promise<unknown | null> => {
  const response = await fetch(url, { headers: buildHeaders() });
  if (response.status === 204 || response.status === 404) return null;
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `user-data-service GET ${url} → ${response.status}: ${body}`,
    );
  }
  return response.json();
};

export const getUserById = async (
  id: string,
): Promise<(User & { id: string }) | null> => {
  const result = await okOrNull(
    `${baseUrl()}/api/user/${encodeURIComponent(id)}`,
  );
  return result ? (result as User & { id: string }) : null;
};

export const getUserByEmail = async (
  email: string,
): Promise<(User & { id: string }) | null> => {
  const result = await okOrNull(
    `${baseUrl()}/api/user/byEmail?email=${encodeURIComponent(email)}`,
  );
  return result ? (result as User & { id: string }) : null;
};

export const createUser = async (
  user: User,
): Promise<User & { id: string }> => {
  const response = await fetch(`${baseUrl()}/api/user`, {
    method: 'POST',
    headers: buildHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(user),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`createUser → ${response.status}: ${body}`);
  }
  const created = (await response.json()) as User & { id: string };
  log.debug(`Created user id=${created.id} email=${user.email}`);
  return created;
};

// PUT /api/user/{id} replaces all columns. Callers should fetch first via
// getUserById and merge changes before calling this.
export const updateUser = async (
  user: User & { id: string },
): Promise<User & { id: string }> => {
  const response = await fetch(
    `${baseUrl()}/api/user/${encodeURIComponent(user.id)}`,
    {
      method: 'PUT',
      headers: buildHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(user),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`updateUser id=${user.id} → ${response.status}: ${body}`);
  }
  return (await response.json()) as User & { id: string };
};

export const getOauthProfileBySub = async (
  sub: string,
): Promise<OauthProfile | null> => {
  const result = await okOrNull(
    `${baseUrl()}/api/oauthProfile/bySub?sub=${encodeURIComponent(sub)}`,
  );
  return result ? (result as OauthProfile) : null;
};

export const upsertOauthProfile = async (
  sub: string,
  userId: string,
  profileJson: string,
): Promise<OauthProfile> => {
  const response = await fetch(`${baseUrl()}/api/oauthProfile`, {
    method: 'PUT',
    headers: buildHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ sub, userId, profileJson }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`upsertOauthProfile → ${response.status}: ${body}`);
  }
  return (await response.json()) as OauthProfile;
};
