import { openAsBlob } from 'fs';
import { writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 } from 'uuid';
import logging from './logging';

const log = logging('imageService');

export type Image = { id: string };

export type ImageServiceClient = {
  url: string;
  apiKey: string;
};

const buildHeaders = (client: ImageServiceClient): Record<string, string> => {
  const headers: Record<string, string> = {};
  if (client.apiKey) headers['X-Api-Key'] = client.apiKey;
  return headers;
};

// Upload a file already on disk to image-service.
export const saveImageToService = async (
  client: ImageServiceClient,
  type: string,
  path: string,
  originalName: string,
  forceImmediateResize: boolean = true,
): Promise<Image> => {
  const url =
    `${client.url.replace(/\/+$/, '')}/api/image/` +
    `${encodeURIComponent(type)}?forceImmediateResize=${forceImmediateResize}`;
  log.debug(`Uploading ${originalName} from ${path} to ${url}`);
  const file = await openAsBlob(path);
  const formData = new FormData();
  formData.append('image', file, originalName);
  const response = await fetch(url, {
    method: 'POST',
    body: formData,
    headers: buildHeaders(client),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `image-service upload HTTP ${response.status}: ${text.slice(0, 200)}`,
    );
  }
  return (await response.json()) as Image;
};

// Download a remote image URL, then upload it to image-service. Returns the
// resulting image-service ID. `accessToken` is used as a bearer token on the
// download request (e.g. when the source URL itself requires auth).
export const downloadAndStoreImage = async (
  client: ImageServiceClient,
  imageUrl: string,
  type: string = 'userIcon',
  accessToken?: string,
): Promise<string> => {
  log.debug(`Downloading image from ${imageUrl}`);
  const downloadResponse = await fetch(
    imageUrl,
    accessToken
      ? { headers: { Authorization: `Bearer ${accessToken}` } }
      : undefined,
  );
  if (!downloadResponse.ok) {
    throw new Error(
      `image download HTTP ${downloadResponse.status} from ${imageUrl}`,
    );
  }

  const parsed = new URL(imageUrl);
  const contentType = downloadResponse.headers.get('content-type');
  let extension = 'png';
  if (contentType) {
    const mime = contentType.split(';')[0].trim();
    const tail = mime.split('/').pop();
    if (tail) extension = tail;
  } else if (parsed.pathname.includes('.')) {
    extension = parsed.pathname.split('.').pop() ?? 'png';
  }

  const buffer = await downloadResponse.arrayBuffer();
  const tempPath = join(tmpdir(), `image-${v4()}.${extension}`);
  await writeFile(tempPath, Buffer.from(buffer));

  const saved = await saveImageToService(
    client,
    type,
    tempPath,
    parsed.pathname,
  );
  log.debug(`Stored image id=${saved.id} for ${imageUrl}`);
  return saved.id;
};

// Resolve an image-service id to a public/signed URL of the given size
// (e.g. 'original', 'thumbnail', etc. — sizes are image-service-specific).
export const getImageUrl = async (
  client: ImageServiceClient,
  imageId: string,
  size: string = 'original',
): Promise<string> => {
  const url =
    `${client.url.replace(/\/+$/, '')}/api/image/s/` +
    `${encodeURIComponent(imageId)}/${encodeURIComponent(size)}`;
  const response = await fetch(url, { headers: buildHeaders(client) });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `image-service lookup HTTP ${response.status}: ${text.slice(0, 200)}`,
    );
  }
  const body = (await response.json()) as { url: string };
  return body.url;
};
