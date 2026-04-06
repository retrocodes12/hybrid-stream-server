import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { createHttpError } from './streamManager.js';

const require = createRequire(import.meta.url);

const PROVIDERS_DIR = path.resolve(process.cwd(), 'vendor/All-in-One-Nuvio/providers');
const IGNORED_PROVIDER_IDS = new Set(['test', 'test2']);
const PROVIDER_PRIORITY = ['vidlink', 'videasy', 'hdhub4u'];

const toLabel = (providerId) =>
  providerId
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());

const discoverProviders = () => {
  const discovered = new Map();

  if (!fs.existsSync(PROVIDERS_DIR)) {
    return discovered;
  }

  const providerFiles = fs.readdirSync(PROVIDERS_DIR)
    .filter((fileName) => fileName.endsWith('.js'))
    .sort();

  for (const fileName of providerFiles) {
    const providerId = path.basename(fileName, '.js').toLowerCase();

    if (IGNORED_PROVIDER_IDS.has(providerId)) {
      continue;
    }

    discovered.set(providerId, {
      id: providerId,
      label: toLabel(providerId),
      modulePath: path.join(PROVIDERS_DIR, fileName)
    });
  }

  return discovered;
};

const toOptionalInteger = (value) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
};

export class ProviderService {
  constructor() {
    this.providers = discoverProviders();
    this.moduleCache = new Map();
    this.resultCache = new Map();
    this.inFlight = new Map();
  }

  listProviders() {
    return this.getProviderOrder().map((providerId) => {
      const provider = this.providers.get(providerId);

      return {
        id: provider.id,
        label: provider.label
      };
    });
  }

  async getAggregateStreams({ providers = null, ...rest }) {
    const normalizedProviders = this.normalizeProviders(providers);

    if (normalizedProviders.length === 0) {
      throw createHttpError(400, 'No valid providers were supplied for aggregate search');
    }

    const settledResults = await Promise.all(normalizedProviders.map(async (provider) => {
      const streams = await this.getStreams({
        provider,
        ...rest
      });

      return {
        provider,
        streams
      };
    }));

    const tried = settledResults.map((result) => ({
      provider: result.provider,
      count: result.streams.length
    }));
    const mergedStreams = [];
    const seenUrls = new Set();

    for (const result of settledResults) {
      for (const stream of result.streams) {
        const normalizedUrl = String(stream.url || '').trim();

        if (!normalizedUrl || seenUrls.has(normalizedUrl)) {
          continue;
        }

        seenUrls.add(normalizedUrl);
        mergedStreams.push({
          ...stream,
          provider: stream.provider || result.provider
        });
      }
    }

    return {
      providers: normalizedProviders,
      tried,
      streams: mergedStreams
    };
  }

  async getStreams({ provider, tmdbId, mediaType = 'movie', season = null, episode = null }) {
    const providerId = String(provider || '').trim().toLowerCase();
    const providerConfig = this.providers.get(providerId);

    if (!providerConfig) {
      throw createHttpError(404, `Unknown provider: ${provider}`);
    }

    const normalizedTmdbId = toOptionalInteger(tmdbId);

    if (!normalizedTmdbId) {
      throw createHttpError(400, 'tmdbId must be a positive integer');
    }

    const normalizedMediaType = String(mediaType || 'movie').trim().toLowerCase();

    if (normalizedMediaType !== 'movie' && normalizedMediaType !== 'tv') {
      throw createHttpError(400, 'mediaType must be movie or tv');
    }

    const normalizedSeason = toOptionalInteger(season);
    const normalizedEpisode = toOptionalInteger(episode);
    const providerModule = this.loadProviderModule(providerConfig);
    const cacheKey = JSON.stringify({
      provider: providerId,
      tmdbId: normalizedTmdbId,
      mediaType: normalizedMediaType,
      season: normalizedSeason,
      episode: normalizedEpisode
    });

    if (typeof providerModule.getStreams !== 'function') {
      throw createHttpError(500, `Provider ${providerId} does not export getStreams`);
    }

    const cached = this.getCachedResult(cacheKey);

    if (cached) {
      logger.info('provider cache hit', {
        provider: providerId,
        tmdbId: normalizedTmdbId,
        mediaType: normalizedMediaType,
        resultCount: cached.length
      });
      return cached;
    }

    if (this.inFlight.has(cacheKey)) {
      return this.inFlight.get(cacheKey);
    }

    const execution = this.executeProviderQuery({
      cacheKey,
      providerId,
      providerModule,
      normalizedTmdbId,
      normalizedMediaType,
      normalizedSeason,
      normalizedEpisode
    });

    this.inFlight.set(cacheKey, execution);

    try {
      return await execution;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  async executeProviderQuery({
    cacheKey,
    providerId,
    providerModule,
    normalizedTmdbId,
    normalizedMediaType,
    normalizedSeason,
    normalizedEpisode
  }) {
    let timeoutId;

    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(createHttpError(504, `Provider ${providerId} timed out`));
      }, config.PROVIDER_TIMEOUT_SECONDS * 1000);
      timeoutId.unref();
    });

    try {
      logger.info('provider scrape started', {
        provider: providerId,
        tmdbId: normalizedTmdbId,
        mediaType: normalizedMediaType
      });

      const streams = await Promise.race([
        providerModule.getStreams(
          normalizedTmdbId,
          normalizedMediaType,
          normalizedSeason,
          normalizedEpisode
        ),
        timeoutPromise
      ]);

      if (!Array.isArray(streams)) {
        throw createHttpError(502, `Provider ${providerId} returned an invalid stream payload`);
      }

      const normalizedStreams = streams.filter((stream) =>
        stream
        && typeof stream === 'object'
        && typeof stream.url === 'string'
        && stream.url.trim()
      );

      this.setCachedResult(cacheKey, normalizedStreams);
      logger.info('provider scrape finished', {
        provider: providerId,
        tmdbId: normalizedTmdbId,
        mediaType: normalizedMediaType,
        resultCount: normalizedStreams.length
      });

      return normalizedStreams;
    } catch (error) {
      if (error?.statusCode === 504) {
        logger.warn('provider scrape timed out', {
          provider: providerId,
          tmdbId: normalizedTmdbId,
          mediaType: normalizedMediaType
        });
        this.setCachedResult(cacheKey, []);
        return [];
      }

      logger.error('provider scrape failed', {
        provider: providerId,
        tmdbId: normalizedTmdbId,
        mediaType: normalizedMediaType,
        error
      });
      this.setCachedResult(cacheKey, []);
      return [];
    } finally {
      clearTimeout(timeoutId);
    }
  }

  getCachedResult(cacheKey) {
    const entry = this.resultCache.get(cacheKey);

    if (!entry) {
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      this.resultCache.delete(cacheKey);
      return null;
    }

    return entry.streams.map((stream) => ({ ...stream }));
  }

  setCachedResult(cacheKey, streams) {
    this.resultCache.set(cacheKey, {
      streams: streams.map((stream) => ({ ...stream })),
      expiresAt: Date.now() + config.PROVIDER_CACHE_TTL_SECONDS * 1000
    });
  }

  normalizeProviders(providers) {
    const requestedProviders = Array.isArray(providers) ? providers : this.getProviderOrder();

    return requestedProviders
      .map((provider) => String(provider || '').trim().toLowerCase())
      .filter(Boolean)
      .filter((provider, index, list) => list.indexOf(provider) === index)
      .filter((provider) => this.providers.has(provider));
  }

  getProviderOrder() {
    const discoveredIds = Array.from(this.providers.keys()).sort();
    const ordered = [];

    for (const providerId of PROVIDER_PRIORITY) {
      if (this.providers.has(providerId)) {
        ordered.push(providerId);
      }
    }

    for (const providerId of discoveredIds) {
      if (!ordered.includes(providerId)) {
        ordered.push(providerId);
      }
    }

    return ordered;
  }

  loadProviderModule(providerConfig) {
    if (this.moduleCache.has(providerConfig.modulePath)) {
      return this.moduleCache.get(providerConfig.modulePath);
    }

    const loadedModule = require(providerConfig.modulePath);
    this.moduleCache.set(providerConfig.modulePath, loadedModule);
    return loadedModule;
  }
}
