import path from 'node:path';

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/fotboll',
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  /** Uploaded photos. Keep on EU storage for GDPR (see README). */
  mediaDir: path.resolve(process.env.MEDIA_DIR ?? 'uploads'),
  /** Built PWA to serve; leave unset in development (Vite serves it). */
  webDist: process.env.WEB_DIST ? path.resolve(process.env.WEB_DIST) : undefined,
  /** The app's public address, e.g. https://fotboll.example.org. Links in emails point here. */
  publicUrl: process.env.PUBLIC_URL?.replace(/\/+$/, '') || undefined,
  /** SMTP server for invitations and password resets, e.g. smtps://user:pass@smtp.example.org:465. */
  smtpUrl: process.env.SMTP_URL || undefined,
  mailFrom: process.env.MAIL_FROM || undefined,
  /**
   * Behind a reverse proxy (Caddy, nginx), set to the number of proxies (usually 1)
   * so rate limits see the visitor's address instead of the proxy's.
   */
  trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY : false,
};
