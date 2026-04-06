import axios from 'axios';

import { config } from '../config.js';
import { createHttpError } from './streamManager.js';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export class ImdbResolverService {
  constructor() {
    this.cache = new Map();
    this.client = axios.create({
      baseURL: 'https://api.themoviedb.org/3',
      timeout: 10_000,
      validateStatus: (status) => status >= 200 && status < 300
    });
  }

  async resolve({ imdbId, mediaType }) {
    const normalizedImdbId = String(imdbId || '').trim();
    const normalizedMediaType = mediaType === 'series' ? 'series' : 'movie';
    const cacheKey = `${normalizedMediaType}:${normalizedImdbId}`;
    const cached = this.cache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.tmdbId;
    }

    if (!/^tt\d+$/u.test(normalizedImdbId)) {
      throw createHttpError(400, 'Stremio id must use an IMDb tt prefix');
    }

    let response = null;
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
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
      }
    }

    if (!response) {
      throw createHttpError(502, `Failed to resolve IMDb id through TMDB: ${lastError?.message || 'unknown error'}`);
    }

    const results = normalizedMediaType === 'series'
      ? response.data?.tv_results
      : response.data?.movie_results;
    const tmdbId = Array.isArray(results) && results[0]?.id ? results[0].id : null;

    if (!tmdbId) {
      return null;
    }

    this.cache.set(cacheKey, {
      tmdbId,
      expiresAt: Date.now() + CACHE_TTL_MS
    });

    return tmdbId;
  }
}
