import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { uuidv7 } from '@fotboll/shared';
import { api, ApiError } from './api';
import { db } from './db';
import { save } from './mutate';

const MAX_SIDE = 800;

/** Resize and re-encode on the device: ~100 kB instead of several MB over a slow network. */
export async function compressImage(file: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const encode = (type: string) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.8));
  // Older Safari cannot encode WebP and silently returns PNG; use JPEG there.
  let blob = await encode('image/webp');
  if (!blob || blob.type !== 'image/webp') blob = await encode('image/jpeg');
  return { blob: blob!, width, height };
}

async function sha256Hex(blob: Blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Store a photo locally and queue it; returns the media id to put on the player or club. */
export async function addPhoto(file: Blob, kind: 'player_photo' | 'club_logo'): Promise<string> {
  const { blob, width, height } = await compressImage(file);
  const id = uuidv7();
  await db.blobs.put({ id, blob, pending: 1 });
  await save('media', {
    id,
    kind,
    sha256: await sha256Hex(blob),
    mime: blob.type as 'image/webp' | 'image/jpeg',
    width,
    height,
  });
  return id;
}

/** Upload photo bytes whose media row has already reached the server. */
export async function uploadPendingMedia() {
  const pending = await db.blobs.where('pending').equals(1).toArray();
  for (const entry of pending) {
    const stillQueued = await db.outbox.where('row_id').equals(entry.id).count();
    if (stillQueued) continue;
    try {
      await api(`/media/${entry.id}`, {
        method: 'PUT',
        body: entry.blob,
        headers: { 'content-type': entry.blob.type },
      });
      await db.blobs.update(entry.id, { pending: 0 });
    } catch (err) {
      // The media row was rejected or deleted: nothing to upload.
      if (err instanceof ApiError && (err.status === 404 || err.status === 403)) await db.blobs.delete(entry.id);
      else throw err;
    }
  }
}

const inflight = new Map<string, Promise<void>>();

async function fetchBlob(id: string) {
  try {
    const blob = await api<Blob>(`/media/${id}`);
    await db.blobs.put({ id, blob, pending: 0 });
  } catch {
    // Offline or not uploaded yet: the placeholder stays until the next render.
  }
}

/** Object URL for a stored image, downloading and caching it on first use. */
export function useMediaUrl(id: string | null | undefined): string | null {
  const entry = useLiveQuery(() => (id ? db.blobs.get(id) : undefined), [id]);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!entry) {
      setUrl(null);
      if (id && entry === undefined && navigator.onLine && !inflight.has(id)) {
        const p = fetchBlob(id).finally(() => inflight.delete(id));
        inflight.set(id, p);
      }
      return;
    }
    const objectUrl = URL.createObjectURL(entry.blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [entry, id]);

  return url;
}
