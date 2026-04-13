import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

import axios from 'axios';

import { config } from '../config.js';
import { createHttpError } from './streamManager.js';
import { logger } from '../utils/logger.js';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const STALE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RETRY_DELAYS_MS = [250, 750, 1500, 3000];
const { mkdir, readFile, writeFile } = fsPromises;

const sleep = (delayMs) => new Promise((resolve) => {
  const timer = setTimeout(resolve, delayMs);
  timer.unref?.();
});

const touchMapEntry = (map, key, value) => {
  map.delete(key);
  map.set(key, value);
};

const pruneMapByMaxEntries = (map, maxEntries) => {
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
    return;
  }

  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;

    if (oldestKey === undefined) {
      break;
    }

    map.delete(oldestKey);
  }
};

export class ImdbResolverService {
  constructor() {
    this.cache = new Map();
    this.inFlight = new Map();
    this.cacheDir = path.join(config.CACHE_DIR, 'imdb-resolver');
    this.client = axios.create({
      baseURL: 'https://api.themoviedb.org/3',
      timeout: 12_000,
      headers: {
        Connection: 'close'
      },
      validateStatus: (status) => status >= 200 && status < 300
    });
  }

  handleMemoryPressure({ critical = false } = {}) {
    if (critical) {
      this.cache.clear();
      return;
    }

    pruneMapByMaxEntries(this.cache, Math.max(50, Math.floor(config.IMDB_RESOLVER_MEMORY_CACHE_MAX_ENTRIES / 4)));
  }

  async resolve({ imdbId, mediaType }) {
    const normalizedImdbId = String(imdbId || '').trim();
    const normalizedMediaType = mediaType === 'series' ? 'series' : 'movie';
    const cacheKey = `${normalizedMediaType}:${normalizedImdbId}`;
    const cached = await this.getCachedEntry(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.tmdbId;
    }

    if (!/^tt\d+$/u.test(normalizedImdbId)) {
      throw createHttpError(400, 'Stremio id must use an IMDb tt prefix');
    }

    if (this.inFlight.has(cacheKey)) {
      return this.inFlight.get(cacheKey);
    }

    const resolution = this.resolveUncached({
      cacheKey,
      normalizedImdbId,
      normalizedMediaType,
      cached
    });

    this.inFlight.set(cacheKey, resolution);

    try {
      return await resolution;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  async resolveUncached({
    cacheKey,
    normalizedImdbId,
    normalizedMediaType,
    cached
  }) {
    let response = null;
    let lastError = null;

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        response = await this.client.get(`/find/${normalizedImdbId}`, {
          params: {
            api_key: config.TMDB_API_KEY,
            external_source: 'imdb_id'
          }
        });
        break;
      } catch (error) {
        lastError = error;

        if (attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]);
        }
      }
    }

    if (!response) {
      if (cached?.tmdbId && cached.staleExpiresAt > Date.now()) {
        logger.warn('using stale imdb resolver cache entry', {
          imdbId: normalizedImdbId,
          mediaType: normalizedMediaType,
          tmdbId: cached.tmdbId,
          error: lastError
        });
        return cached.tmdbId;
      }

      throw createHttpError(502, `Failed to resolve IMDb id through TMDB: ${lastError?.message || 'unknown error'}`);
    }

    const results = normalizedMediaType === 'series'
      ? response.data?.tv_results
      : response.data?.movie_results;
    const tmdbId = Array.isArray(results) && results[0]?.id ? results[0].id : null;

    if (!tmdbId) {
      return null;
    }

    await this.setCachedEntry(cacheKey, tmdbId);

    return tmdbId;
  }

  getCacheFilePath(cacheKey) {
    return path.join(this.cacheDir, `${cacheKey.replaceAll(':', '__')}.json`);
  }

  async getCachedEntry(cacheKey) {
    const memoryEntry = this.cache.get(cacheKey);

    if (memoryEntry && memoryEntry.staleExpiresAt > Date.now()) {
      touchMapEntry(this.cache, cacheKey, memoryEntry);
      return memoryEntry;
    }

    const diskEntry = await this.getDiskCachedEntry(cacheKey);

    if (diskEntry) {
      this.cache.set(cacheKey, diskEntry);
      pruneMapByMaxEntries(this.cache, config.IMDB_RESOLVER_MEMORY_CACHE_MAX_ENTRIES);
      return diskEntry;
    }

    if (memoryEntry) {
      this.cache.delete(cacheKey);
    }

    return null;
  }

  async getDiskCachedEntry(cacheKey) {
    try {
      const payload = JSON.parse(await readFile(this.getCacheFilePath(cacheKey), 'utf8'));

      if (!payload || !payload.tmdbId || payload.staleExpiresAt <= Date.now()) {
        return null;
      }

      return {
        tmdbId: payload.tmdbId,
        expiresAt: payload.expiresAt,
        staleExpiresAt: payload.staleExpiresAt
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn('imdb resolver disk cache read failed', {
          cacheKey,
          error
        });
      }

      return null;
    }
  }

  async setCachedEntry(cacheKey, tmdbId) {
    const entry = {
      tmdbId,
      expiresAt: Date.now() + CACHE_TTL_MS,
      staleExpiresAt: Date.now() + STALE_CACHE_TTL_MS
    };

    touchMapEntry(this.cache, cacheKey, entry);
    pruneMapByMaxEntries(this.cache, config.IMDB_RESOLVER_MEMORY_CACHE_MAX_ENTRIES);

    try {
      await mkdir(this.cacheDir, { recursive: true });
      await writeFile(this.getCacheFilePath(cacheKey), JSON.stringify(entry));
    } catch (error) {
      logger.warn('imdb resolver disk cache write failed', {
        cacheKey,
        error
      });
    }
  }
}
