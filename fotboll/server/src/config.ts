import path from 'node:path';

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/fotboll',
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  /** Uploaded photos. Keep on EU storage for GDPR (see README). */
  mediaDir: path.resolve(process.env.MEDIA_DIR ?? 'uploads'),
  /** Built PWA to serve; leave unset in development (Vite serves it). */
  webDist: process.env.WEB_DIST ? path.resolve(process.env.WEB_DIST) : undefined,
};
