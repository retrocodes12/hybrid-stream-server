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
  PROVIDER_CACHE_TTL_SECONDS: toPositiveInteger(process.env.PROVIDER_CACHE_TTL_SECONDS, 300)
});

export const cacheConfig = Object.freeze({
  HTTP_CACHE_DIR: path.join(config.CACHE_DIR, 'http'),
  TORRENT_CACHE_DIR: path.join(config.CACHE_DIR, 'torrents'),
  MAX_CACHE_SIZE_BYTES: Math.floor(config.MAX_CACHE_SIZE_GB * 1024 * 1024 * 1024)
});
