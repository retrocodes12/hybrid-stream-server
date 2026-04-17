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

const toBoolean = (value, fallback) => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
};

export const config = Object.freeze({
  PORT: toPositiveInteger(process.env.PORT, 3000),
  CACHE_DIR: path.resolve(process.cwd(), process.env.CACHE_DIR || './cache'),
  PUBLIC_BASE_URL: String(process.env.PUBLIC_BASE_URL || 'https://nebulastreams.onrender.com').trim().replace(/\/+$/u, ''),
  REVERSE_PROXY_TARGET: String(process.env.REVERSE_PROXY_TARGET || '').trim().replace(/\/+$/u, ''),
  REVERSE_PROXY_TIMEOUT_SECONDS: toPositiveInteger(process.env.REVERSE_PROXY_TIMEOUT_SECONDS, 60),
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'sohil@123',
  STREMIO_ADDON_ID: process.env.STREMIO_ADDON_ID || 'community.nebulastreams',
  STREMIO_ADDON_NAME: process.env.STREMIO_ADDON_NAME || 'NebulaStreams',
  DONATION_PRIMARY_URL: process.env.DONATION_PRIMARY_URL || 'https://ko-fi.com/redx115775',
  DONATION_SECONDARY_URL: process.env.DONATION_SECONDARY_URL || '',
  DONATION_NOWPAYMENTS_WIDGET_URL: process.env.DONATION_NOWPAYMENTS_WIDGET_URL || 'https://nowpayments.io/embeds/donation-widget?api_key=3acd79dd-66e2-48c4-9a7a-8938cb9a7a12',
  DONATION_UPI_ID: process.env.DONATION_UPI_ID || 'sohilsuresh2@okhdfcbank',
  DONATION_CRYPTO_LABEL: process.env.DONATION_CRYPTO_LABEL || 'USDT (TRC20)',
  DONATION_CRYPTO_ADDRESS: process.env.DONATION_CRYPTO_ADDRESS || 'TF1WTj7BZVdU64rtMHsKwKrbqVXWtSynoD',
  TMDB_API_KEY: process.env.TMDB_API_KEY || '439c478a771f35c05022f9feabcca01c',
  REDIS_URL: String(process.env.REDIS_URL || '').trim(),
  REDIS_CACHE_PREFIX: String(process.env.REDIS_CACHE_PREFIX || 'nebulastreams').trim() || 'nebulastreams',
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
  PUBLIC_RATE_LIMIT_WINDOW_SECONDS: toPositiveInteger(process.env.PUBLIC_RATE_LIMIT_WINDOW_SECONDS, 60),
  PUBLIC_RATE_LIMIT_MAX_REQUESTS: toPositiveInteger(process.env.PUBLIC_RATE_LIMIT_MAX_REQUESTS, 90),
  STREAM_RATE_LIMIT_WINDOW_SECONDS: toPositiveInteger(process.env.STREAM_RATE_LIMIT_WINDOW_SECONDS, 60),
  STREAM_RATE_LIMIT_MAX_REQUESTS: toPositiveInteger(process.env.STREAM_RATE_LIMIT_MAX_REQUESTS, 24),
  PROVIDER_RATE_LIMIT_WINDOW_SECONDS: toPositiveInteger(process.env.PROVIDER_RATE_LIMIT_WINDOW_SECONDS, 60),
  PROVIDER_RATE_LIMIT_MAX_REQUESTS: toPositiveInteger(process.env.PROVIDER_RATE_LIMIT_MAX_REQUESTS, 12),
  PROVIDER_TIMEOUT_SECONDS: toPositiveInteger(process.env.PROVIDER_TIMEOUT_SECONDS, 10),
  PROVIDER_CACHE_TTL_SECONDS: toPositiveInteger(process.env.PROVIDER_CACHE_TTL_SECONDS, 3600),
  PROVIDER_EMPTY_CACHE_TTL_SECONDS: toPositiveInteger(process.env.PROVIDER_EMPTY_CACHE_TTL_SECONDS, 900),
  PROVIDER_PRIORITY_EMPTY_CACHE_TTL_SECONDS: toPositiveInteger(process.env.PROVIDER_PRIORITY_EMPTY_CACHE_TTL_SECONDS, 60),
  PROVIDER_FAILURE_THRESHOLD: toPositiveInteger(process.env.PROVIDER_FAILURE_THRESHOLD, 3),
  PROVIDER_COOLDOWN_SECONDS: toPositiveInteger(process.env.PROVIDER_COOLDOWN_SECONDS, 180),
  PROVIDER_HOST_FAILURE_THRESHOLD: toPositiveInteger(process.env.PROVIDER_HOST_FAILURE_THRESHOLD, 4),
  PROVIDER_HOST_COOLDOWN_SECONDS: toPositiveInteger(process.env.PROVIDER_HOST_COOLDOWN_SECONDS, 180),
  PROVIDER_HOST_MAX_INFLIGHT: toBoundedInteger(process.env.PROVIDER_HOST_MAX_INFLIGHT, 1, 1, 4),
  PROVIDER_MAX_CONCURRENCY: toBoundedInteger(process.env.PROVIDER_MAX_CONCURRENCY, 4, 1, 8),
  PROVIDER_GLOBAL_MAX_INFLIGHT: toBoundedInteger(process.env.PROVIDER_GLOBAL_MAX_INFLIGHT, 4, 1, 32),
  PROVIDER_RESULT_MEMORY_CACHE_MAX_ENTRIES: toBoundedInteger(process.env.PROVIDER_RESULT_MEMORY_CACHE_MAX_ENTRIES, 500, 50, 5000),
  PROVIDER_RESULT_MEMORY_CACHE_MAX_MB: toBoundedInteger(process.env.PROVIDER_RESULT_MEMORY_CACHE_MAX_MB, 4, 1, 256),
  TMDB_METADATA_MEMORY_CACHE_MAX_ENTRIES: toBoundedInteger(process.env.TMDB_METADATA_MEMORY_CACHE_MAX_ENTRIES, 1000, 50, 5000),
  MAX_ACTIVE_STREAMS: toBoundedInteger(process.env.MAX_ACTIVE_STREAMS, 8, 1, 32),
  STREMIO_FAST_PROVIDER_CONCURRENCY: toBoundedInteger(process.env.STREMIO_FAST_PROVIDER_CONCURRENCY, 3, 1, 8),
  STREMIO_FAST_PROVIDER_LIMIT: toBoundedInteger(process.env.STREMIO_FAST_PROVIDER_LIMIT, 5, 1, 40),
  STREMIO_FAST_STREAM_LIMIT: toBoundedInteger(process.env.STREMIO_FAST_STREAM_LIMIT, 24, 4, 60),
  STREMIO_FAST_EARLY_RETURN_STREAMS: toBoundedInteger(process.env.STREMIO_FAST_EARLY_RETURN_STREAMS, 6, 4, 60),
  STREMIO_FAST_MIN_COMPLETED_PROVIDERS: toBoundedInteger(process.env.STREMIO_FAST_MIN_COMPLETED_PROVIDERS, 2, 1, 12),
  STREMIO_FAST_MAX_WAIT_MS: toBoundedInteger(process.env.STREMIO_FAST_MAX_WAIT_MS, 8000, 1000, 60000),
  STREMIO_RESULT_CACHE_TTL_SECONDS: toPositiveInteger(process.env.STREMIO_RESULT_CACHE_TTL_SECONDS, 3600),
  STREMIO_EMPTY_RESULT_CACHE_TTL_SECONDS: toPositiveInteger(process.env.STREMIO_EMPTY_RESULT_CACHE_TTL_SECONDS, 5),
  STREMIO_WEAK_RESULT_CACHE_TTL_SECONDS: toPositiveInteger(process.env.STREMIO_WEAK_RESULT_CACHE_TTL_SECONDS, 300),
  STREMIO_RESULT_STALE_TTL_SECONDS: toBoundedInteger(process.env.STREMIO_RESULT_STALE_TTL_SECONDS, 43200, 300, 86400),
  STREMIO_RESULT_MEMORY_CACHE_MAX_ENTRIES: toBoundedInteger(process.env.STREMIO_RESULT_MEMORY_CACHE_MAX_ENTRIES, 500, 50, 5000),
  STREMIO_RESULT_MEMORY_CACHE_MAX_MB: toBoundedInteger(process.env.STREMIO_RESULT_MEMORY_CACHE_MAX_MB, 8, 1, 256),
  STREMIO_MAX_INFLIGHT_SEARCHES: toBoundedInteger(process.env.STREMIO_MAX_INFLIGHT_SEARCHES, 50, 4, 500),
  STREMIO_INFLIGHT_SLOT_WAIT_MS: toBoundedInteger(process.env.STREMIO_INFLIGHT_SLOT_WAIT_MS, 8000, 0, 60000),
  STREMIO_BACKGROUND_REFRESH_CONCURRENCY: toBoundedInteger(process.env.STREMIO_BACKGROUND_REFRESH_CONCURRENCY, 1, 0, 8),
  STREMIO_BACKGROUND_REFRESH_QUEUE_MAX: toBoundedInteger(process.env.STREMIO_BACKGROUND_REFRESH_QUEUE_MAX, 50, 0, 1000),
  POPULAR_STREAM_PREWARM_ENABLED: toBoolean(process.env.POPULAR_STREAM_PREWARM_ENABLED, true),
  POPULAR_STREAM_PREWARM_INTERVAL_SECONDS: toBoundedInteger(process.env.POPULAR_STREAM_PREWARM_INTERVAL_SECONDS, 900, 60, 86400),
  POPULAR_STREAM_PREWARM_LIMIT: toBoundedInteger(process.env.POPULAR_STREAM_PREWARM_LIMIT, 20, 1, 100),
  POPULAR_STREAM_PREWARM_MAX_AGE_HOURS: toBoundedInteger(process.env.POPULAR_STREAM_PREWARM_MAX_AGE_HOURS, 72, 1, 720),
  POPULAR_STREAM_SEARCH_MAX_ENTRIES: toBoundedInteger(process.env.POPULAR_STREAM_SEARCH_MAX_ENTRIES, 500, 50, 5000),
  POPULAR_STREAM_SEARCH_MAX_USERS_PER_ENTRY: toBoundedInteger(process.env.POPULAR_STREAM_SEARCH_MAX_USERS_PER_ENTRY, 200, 10, 2000),
  STREAM_RESULT_EXTERNAL_CACHE_ENABLED: toBoolean(process.env.STREAM_RESULT_EXTERNAL_CACHE_ENABLED, Boolean(String(process.env.REDIS_URL || '').trim())),
  HUBCLOUD_MEMORY_CACHE_MAX_ENTRIES: toBoundedInteger(process.env.HUBCLOUD_MEMORY_CACHE_MAX_ENTRIES, 300, 20, 3000),
  HUBCLOUD_MEMORY_CACHE_MAX_MB: toBoundedInteger(process.env.HUBCLOUD_MEMORY_CACHE_MAX_MB, 2, 1, 128),
  IMDB_RESOLVER_MEMORY_CACHE_MAX_ENTRIES: toBoundedInteger(process.env.IMDB_RESOLVER_MEMORY_CACHE_MAX_ENTRIES, 1000, 50, 5000),
  USER_TRACKER_MAX_ENTRIES: toBoundedInteger(process.env.USER_TRACKER_MAX_ENTRIES, 20000, 1000, 200000),
  SOURCE_REGISTRY_MAX_ENTRIES: toBoundedInteger(process.env.SOURCE_REGISTRY_MAX_ENTRIES, 5000, 100, 50000),
  RATE_LIMIT_MAX_BUCKETS: toBoundedInteger(process.env.RATE_LIMIT_MAX_BUCKETS, 50000, 1000, 500000),
  MEMORY_GUARD_ENABLED: toBoolean(process.env.MEMORY_GUARD_ENABLED, true),
  MEMORY_GUARD_INTERVAL_SECONDS: toBoundedInteger(process.env.MEMORY_GUARD_INTERVAL_SECONDS, 15, 5, 300),
  MEMORY_GUARD_PRESSURE_PERCENT: toBoundedInteger(process.env.MEMORY_GUARD_PRESSURE_PERCENT, 75, 50, 98),
  MEMORY_GUARD_CRITICAL_PERCENT: toBoundedInteger(process.env.MEMORY_GUARD_CRITICAL_PERCENT, 88, 60, 99),
  MEMORY_GUARD_RESTART_PERCENT: toBoundedInteger(process.env.MEMORY_GUARD_RESTART_PERCENT, 94, 70, 99),
  MEMORY_GUARD_RESTART_AFTER_CRITICAL: toBoundedInteger(process.env.MEMORY_GUARD_RESTART_AFTER_CRITICAL, 3, 1, 10),
  MEMORY_GUARD_MIN_AVAILABLE_MB: toBoundedInteger(process.env.MEMORY_GUARD_MIN_AVAILABLE_MB, 128, 32, 1024),
  MEMORY_GUARD_SHED_SECONDS: toBoundedInteger(process.env.MEMORY_GUARD_SHED_SECONDS, 180, 10, 600),
  BOT_PROTECTION_ENABLED: toBoolean(process.env.BOT_PROTECTION_ENABLED, true),
  BOT_PROTECTION_WINDOW_SECONDS: toBoundedInteger(process.env.BOT_PROTECTION_WINDOW_SECONDS, 60, 10, 600),
  BOT_PROTECTION_EXPENSIVE_REQUEST_LIMIT: toBoundedInteger(process.env.BOT_PROTECTION_EXPENSIVE_REQUEST_LIMIT, 12, 4, 300),
  BOT_PROTECTION_SUSPICIOUS_REQUEST_LIMIT: toBoundedInteger(process.env.BOT_PROTECTION_SUSPICIOUS_REQUEST_LIMIT, 2, 1, 100),
  BOT_PROTECTION_BLOCK_SECONDS: toBoundedInteger(process.env.BOT_PROTECTION_BLOCK_SECONDS, 1800, 60, 86400),
  BOT_PROTECTION_MAX_TRACKED_CLIENTS: toBoundedInteger(process.env.BOT_PROTECTION_MAX_TRACKED_CLIENTS, 50000, 1000, 500000)
});

export const cacheConfig = Object.freeze({
  HTTP_CACHE_DIR: path.join(config.CACHE_DIR, 'http'),
  PROVIDER_CACHE_DIR: path.join(config.CACHE_DIR, 'provider-results'),
  STREMIO_RESULT_CACHE_DIR: path.join(config.CACHE_DIR, 'stremio-results'),
  TORRENT_CACHE_DIR: path.join(config.CACHE_DIR, 'torrents'),
  MAX_CACHE_SIZE_BYTES: Math.floor(config.MAX_CACHE_SIZE_GB * 1024 * 1024 * 1024)
});
