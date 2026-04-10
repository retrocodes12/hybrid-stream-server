import path from 'node:path';

const toPositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);

  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }

  return fallback;
};

const toPositiveNumber = (value, fallback) => {
  const parsed = Number.parseFloat(value ?? '');

  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return fallback;
};

const toBoundedInteger = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value ?? '', 10);

  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
};

export const config = Object.freeze({
  PORT: toPositiveInteger(process.env.PORT, 3000),
  CACHE_DIR: path.resolve(process.cwd(), process.env.CACHE_DIR || './cache'),
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'sohil@123',
  STREMIO_ADDON_ID: process.env.STREMIO_ADDON_ID || 'community.nebulastreams',
  STREMIO_ADDON_NAME: process.env.STREMIO_ADDON_NAME || 'NebulaStreams',
  DONATION_PRIMARY_URL: process.env.DONATION_PRIMARY_URL || '',
  DONATION_SECONDARY_URL: process.env.DONATION_SECONDARY_URL || '',
  DONATION_UPI_ID: process.env.DONATION_UPI_ID || '',
  TMDB_API_KEY: process.env.TMDB_API_KEY || '439c478a771f35c05022f9feabcca01c',
  MAX_CACHE_SIZE_GB: toPositiveNumber(process.env.MAX_CACHE_SIZE_GB, 10),
  MAX_ACTIVE_TORRENTS: toBoundedInteger(process.env.MAX_ACTIVE_TORRENTS, 1, 1, 2),
  TORRENT_CONNECTIONS: toBoundedInteger(process.env.TORRENT_CONNECTIONS, 80, 80, 100),
  TORRENT_METADATA_TIMEOUT_SECONDS: toPositiveInteger(process.env.TORRENT_METADATA_TIMEOUT_SECONDS, 25),
  TORRENT_IDLE_TTL_SECONDS: toPositiveInteger(process.env.TORRENT_IDLE_TTL_SECONDS, 120),
  TORRENT_CLEANUP_INTERVAL_SECONDS: toPositiveInteger(process.env.TORRENT_CLEANUP_INTERVAL_SECONDS, 30),
  HTTP_STREAM_TIMEOUT_SECONDS: toPositiveInteger(process.env.HTTP_STREAM_TIMEOUT_SECONDS, 20),
  HTTP_MAX_SOCKETS: toBoundedInteger(process.env.HTTP_MAX_SOCKETS, 8, 2, 16),
  HTTP_MAX_FREE_SOCKETS: toBoundedInteger(process.env.HTTP_MAX_FREE_SOCKETS, 4, 1, 8),
  HTTP_KEEP_ALIVE_MILLISECONDS: toPositiveInteger(process.env.HTTP_KEEP_ALIVE_MILLISECONDS, 1000),
  PROVIDER_TIMEOUT_SECONDS: toPositiveInteger(process.env.PROVIDER_TIMEOUT_SECONDS, 10),
  PROVIDER_CACHE_TTL_SECONDS: toPositiveInteger(process.env.PROVIDER_CACHE_TTL_SECONDS, 300),
  PROVIDER_MAX_CONCURRENCY: toBoundedInteger(process.env.PROVIDER_MAX_CONCURRENCY, 4, 1, 8),
  MAX_ACTIVE_STREAMS: toBoundedInteger(process.env.MAX_ACTIVE_STREAMS, 8, 1, 32),
  STREMIO_FAST_PROVIDER_CONCURRENCY: toBoundedInteger(process.env.STREMIO_FAST_PROVIDER_CONCURRENCY, 4, 1, 8),
  STREMIO_FAST_STREAM_LIMIT: toBoundedInteger(process.env.STREMIO_FAST_STREAM_LIMIT, 24, 4, 60)
});

export const cacheConfig = Object.freeze({
  HTTP_CACHE_DIR: path.join(config.CACHE_DIR, 'http'),
  PROVIDER_CACHE_DIR: path.join(config.CACHE_DIR, 'provider-results'),
  TORRENT_CACHE_DIR: path.join(config.CACHE_DIR, 'torrents'),
  MAX_CACHE_SIZE_BYTES: Math.floor(config.MAX_CACHE_SIZE_GB * 1024 * 1024 * 1024)
});
