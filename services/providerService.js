import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { promises as fsPromises } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { createHttpError } from './streamManager.js';

const require = createRequire(import.meta.url);
const { mkdir, readFile, readdir, rm, writeFile } = fsPromises;
const execFileAsync = promisify(execFile);

const PROVIDERS_DIR = path.resolve(process.cwd(), 'vendor/All-in-One-Nuvio/providers');
const LOCAL_PROVIDERS = Object.freeze({
  tamilian: {
    id: 'tamilian',
    label: 'Tamilian',
    modulePath: path.resolve(process.cwd(), 'providers/tamilian.cjs')
  },
  'torrent-scraper': {
    id: 'torrent-scraper',
    label: 'Torrent Scraper',
    modulePath: path.resolve(process.cwd(), 'providers/torrent-scraper.cjs'),
    runnerPath: path.resolve(process.cwd(), 'providers/torrent-scraper-runner.cjs'),
    invocation: 'subprocess'
  }
});
const PROVIDER_CACHE_VERSION = '3';
const IGNORED_PROVIDER_IDS = new Set(['test', 'test2']);
const NO_EMPTY_CACHE_PROVIDERS = new Set(['torrent-scraper']);
const PROVIDER_PRIORITY = ['vidlink', 'videasy', 'hdhub4u', 'tamilian', 'torrent-scraper'];
const STREMIO_EXCLUDED_PROVIDERS = new Set(['torrent-scraper']);
const TMDB_METADATA_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CONTENT_PROVIDER_BOOSTS = Object.freeze({
  anime: Object.freeze({
    'anime-sama': 180,
    animekai: 175,
    animesalt: 170,
    animeworld: 165,
    kisskh: 55
  }),
  kdrama: Object.freeze({
    onlykdrama: 180,
    kisskh: 120,
    showbox: 40
  }),
  indian: Object.freeze({
    tamilian: 165,
    isaidub: 155,
    hindmoviez: 145,
    flixindia: 145,
    hdhub4u: 135,
    '4khdhub': 125,
    '4khdhub_tv': 125,
    streamflix: 110,
    streamflix_eng: 105,
    moviesmod: 100,
    allwish: 80,
    allmovieland: 70
  }),
  turkish: Object.freeze({
    diziyou: 180
  }),
  portuguese: Object.freeze({
    brazucaplay: 180
  }),
  spanish: Object.freeze({
    lamovie: 170,
    purstream: 130
  })
});
const PROVIDER_RELIABILITY_SCORES = Object.freeze({
  vidlink: 120,
  videasy: 115,
  hdhub4u: 110,
  tamilian: 104,
  'torrent-scraper': 80,
  streamflix: 105,
  netmirror: 100,
  moviebox: 98,
  movix: 96,
  dooflix: 94,
  vixsrc: 92,
  hdmovie2: 90,
  lamovie: 88,
  purstream: 86
});
const INDIAN_LANGUAGES = new Set(['ta', 'te', 'hi', 'ml', 'kn']);

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

  for (const provider of Object.values(LOCAL_PROVIDERS)) {
    discovered.set(provider.id, provider);
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

const mapConcurrent = async (items, concurrency, iteratee) => {
  const results = new Array(items.length);
  let currentIndex = 0;

  const worker = async () => {
    while (true) {
      const index = currentIndex;
      currentIndex += 1;

      if (index >= items.length) {
        return;
      }

      results[index] = await iteratee(items[index], index);
    }
  };

  const workers = Array.from({
    length: Math.min(concurrency, items.length)
  }, () => worker());

  await Promise.all(workers);
  return results;
};

const copyStreams = (streams) => streams.map((stream) => ({ ...stream }));

const sanitizeHeaders = (headers) => {
  if (!headers || typeof headers !== 'object') {
    return null;
  }

  const sanitized = {};

  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (typeof headerName !== 'string' || typeof headerValue !== 'string') {
      continue;
    }

    const normalizedName = headerName.trim();
    const normalizedValue = headerValue.trim();

    if (!normalizedName || !normalizedValue) {
      continue;
    }

    sanitized[normalizedName] = normalizedValue;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : null;
};

const sanitizeProviderStream = (stream) => {
  if (!stream || typeof stream !== 'object') {
    return null;
  }

  const normalizedMagnet = typeof stream.magnet === 'string'
    ? String(stream.magnet).trim()
    : typeof stream.torrent === 'string'
      ? String(stream.torrent).trim()
      : '';

  if (normalizedMagnet && !normalizedMagnet.startsWith('magnet:?')) {
    return null;
  }

  const normalizedUrl = String(stream.url || '').trim();
  let parsedUrl = null;

  if (normalizedUrl) {
    try {
      parsedUrl = new URL(normalizedUrl);
    } catch {
      parsedUrl = null;
    }
  }

  if (parsedUrl && !['http:', 'https:'].includes(parsedUrl.protocol)) {
    parsedUrl = null;
  }

  if (!normalizedMagnet && !parsedUrl) {
    return null;
  }

  const {
    headers: _headers,
    magnet: _magnet,
    torrent: _torrent,
    url: _url,
    ...rest
  } = stream;

  return {
    ...rest,
    ...(parsedUrl ? { url: parsedUrl.toString() } : {}),
    ...(normalizedMagnet ? { magnet: normalizedMagnet } : {}),
    headers: sanitizeHeaders(stream.headers)
  };
};

const toQualityScore = (quality) => {
  const normalized = String(quality || '').trim().toLowerCase();

  if (!normalized) {
    return 0;
  }

  if (normalized === '4k') {
    return 2160;
  }

  if (normalized === 'auto' || normalized === 'adaptive') {
    return 850;
  }

  const match = normalized.match(/(\d{3,4})/);

  if (match?.[1]) {
    return Number.parseInt(match[1], 10);
  }

  return 0;
};

const toTransportScore = (url) => {
  const normalized = String(url || '').toLowerCase();

  if (normalized.includes('.mp4') || normalized.includes('.mkv') || normalized.includes('.avi') || normalized.includes('.webm')) {
    return 40;
  }

  if (normalized.includes('.m3u8')) {
    return 32;
  }

  if (normalized.includes('pixeldrain') || normalized.includes('vidlink') || normalized.includes('videasy')) {
    return 24;
  }

  return 10;
};

const toHeaderScore = (headers) => {
  if (!headers || typeof headers !== 'object') {
    return 0;
  }

  const headerNames = Object.keys(headers).map((headerName) => headerName.toLowerCase());
  let score = 0;

  if (headerNames.includes('referer')) {
    score += 2;
  }

  if (headerNames.includes('user-agent')) {
    score += 1;
  }

  return score;
};

const getProviderContentBoost = (providerId, contentProfile) => {
  if (!contentProfile || !Array.isArray(contentProfile.tags)) {
    return 0;
  }

  return contentProfile.tags.reduce((total, tag) => {
    const tagBoosts = CONTENT_PROVIDER_BOOSTS[tag];

    if (!tagBoosts || !Object.hasOwn(tagBoosts, providerId)) {
      return total;
    }

    return total + tagBoosts[providerId];
  }, 0);
};

const toProviderScore = (providerId, providerOrder, contentProfile = null) => {
  const baseReliability = Object.hasOwn(PROVIDER_RELIABILITY_SCORES, providerId)
    ? PROVIDER_RELIABILITY_SCORES[providerId]
    : 0;
  const contentBoost = getProviderContentBoost(providerId, contentProfile);
  const index = providerOrder.indexOf(providerId);

  if (index === -1) {
    return baseReliability + contentBoost;
  }

  return baseReliability + contentBoost + Math.max(providerOrder.length - index, 1);
};

const rankStream = (stream, providerOrder, contentProfile = null) => {
  const providerId = String(stream.provider || '').toLowerCase();
  const qualityScore = toQualityScore(stream.quality);
  const transportScore = stream.url ? toTransportScore(stream.url) : stream.magnet ? 6 : 10;
  const headerScore = toHeaderScore(stream.headers);
  const providerScore = toProviderScore(providerId, providerOrder, contentProfile);

  return (providerScore * 10000) + (qualityScore * 100) + (transportScore * 10) + headerScore;
};

export class ProviderService {
  constructor() {
    this.providers = discoverProviders();
    this.providerCacheDir = path.join(config.CACHE_DIR, 'provider-results');
    this.moduleCache = new Map();
    this.resultCache = new Map();
    this.inFlight = new Map();
    this.providerHealth = new Map();
    this.providerHostHealth = new Map();
    this.providerHostInflight = new Map();
    this.tmdbMetadataCache = new Map();
    this.tmdbMetadataInFlight = new Map();
  }

  async initialize() {
    await mkdir(this.providerCacheDir, { recursive: true });
    await this.removeExpiredDiskEntries();
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

  getStats() {
    const now = Date.now();
    let coolingDownProviders = 0;
    let coolingDownHosts = 0;

    for (const state of this.providerHealth.values()) {
      if ((state.cooldownUntil || 0) > now) {
        coolingDownProviders += 1;
      }
    }

    for (const state of this.providerHostHealth.values()) {
      if ((state.cooldownUntil || 0) > now) {
        coolingDownHosts += 1;
      }
    }

    return {
      discoveredProviders: this.providers.size,
      inMemoryCacheEntries: this.resultCache.size,
      inFlightRequests: this.inFlight.size,
      providerCacheDir: this.providerCacheDir,
      coolingDownProviders,
      coolingDownHosts
    };
  }

  getStremioProviderOrder(requestedProviders = null, contentProfile = null) {
    const candidates = this.getProviderOrder(contentProfile, requestedProviders && requestedProviders.length > 0 ? requestedProviders : null);

    return candidates.filter((providerId) => !STREMIO_EXCLUDED_PROVIDERS.has(providerId));
  }

  async getContentProfile({ tmdbId, mediaType }) {
    try {
      const metadata = await this.getTmdbMetadata({ tmdbId, mediaType });
      return this.buildContentProfile(metadata, mediaType);
    } catch (error) {
      logger.warn('content profile detection failed', {
        tmdbId,
        mediaType,
        error
      });
      return null;
    }
  }

  async getAggregateStreams({ providers = null, ...rest }) {
    const contentProfile = rest.contentProfile || await this.getContentProfile(rest);
    const normalizedProviders = this.getProviderOrder(contentProfile, providers);

    if (normalizedProviders.length === 0) {
      throw createHttpError(400, 'No valid providers were supplied for aggregate search');
    }

    const settledResults = await mapConcurrent(normalizedProviders, config.PROVIDER_MAX_CONCURRENCY, async (provider) => {
      const streams = await this.getStreams({
        provider,
        ...rest
      });

      return {
        provider,
        streams
      };
    });

    const tried = settledResults.map((result) => ({
      provider: result.provider,
      count: result.streams.length
    }));
    const mergedStreams = [];
    const seenSources = new Set();

    for (const result of settledResults) {
      for (const stream of result.streams) {
        const normalizedUrl = String(stream.url || '').trim();
        const normalizedMagnet = String(stream.magnet || stream.torrent || '').trim();
        const dedupeKey = JSON.stringify({
          url: normalizedUrl || null,
          magnet: normalizedMagnet || null
        });

        if ((!normalizedUrl && !normalizedMagnet) || seenSources.has(dedupeKey)) {
          continue;
        }

        seenSources.add(dedupeKey);
        mergedStreams.push({
          ...stream,
          provider: stream.provider || result.provider
        });
      }
    }

    mergedStreams.sort((left, right) => {
      const scoreDelta = rankStream(right, normalizedProviders, contentProfile) - rankStream(left, normalizedProviders, contentProfile);

      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      return String(left.name || left.title || left.url).localeCompare(
        String(right.name || right.title || right.url)
      );
    });

    return {
      providers: normalizedProviders,
      tried,
      streams: mergedStreams
    };
  }

  async getFastStreams({ providers = null, ...rest }) {
    const contentProfile = rest.contentProfile || await this.getContentProfile(rest);
    const normalizedProviders = this.getStremioProviderOrder(
      providers && providers.length > 0 ? providers : null,
      contentProfile
    );

    if (normalizedProviders.length === 0) {
      throw createHttpError(400, 'No valid providers were supplied for fast search');
    }

    const settledResults = await mapConcurrent(
      normalizedProviders,
      config.STREMIO_FAST_PROVIDER_CONCURRENCY,
      async (provider) => {
        const streams = await this.getStreams({
          provider,
          ...rest
        });

        return {
          provider,
          streams
        };
      }
    );

    const tried = settledResults.map((result) => ({
      provider: result.provider,
      count: result.streams.length
    }));
    const mergedStreams = [];
    const seenSources = new Set();

    for (const result of settledResults) {
      for (const stream of result.streams) {
        const normalizedUrl = String(stream.url || '').trim();
        const normalizedMagnet = String(stream.magnet || stream.torrent || '').trim();
        const dedupeKey = JSON.stringify({
          url: normalizedUrl || null,
          magnet: normalizedMagnet || null
        });

        if ((!normalizedUrl && !normalizedMagnet) || seenSources.has(dedupeKey)) {
          continue;
        }

        seenSources.add(dedupeKey);
        mergedStreams.push({
          ...stream,
          provider: stream.provider || result.provider
        });
      }
    }

    mergedStreams.sort((left, right) => {
      const scoreDelta = rankStream(right, normalizedProviders, contentProfile) - rankStream(left, normalizedProviders, contentProfile);

      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      return String(left.name || left.title || left.url).localeCompare(
        String(right.name || right.title || right.url)
      );
    });

    return {
      providers: normalizedProviders,
      tried,
      streams: mergedStreams.slice(0, config.STREMIO_FAST_STREAM_LIMIT)
    };
  }

  async getStreams({ provider, tmdbId, mediaType = 'movie', season = null, episode = null }) {
    const providerId = String(provider || '').trim().toLowerCase();
    const providerConfig = this.providers.get(providerId);

    if (!providerConfig) {
      throw createHttpError(404, `Unknown provider: ${provider}`);
    }
    const providerHostKey = this.getProviderHostKey(providerId);

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
    const cacheKey = JSON.stringify({
      version: PROVIDER_CACHE_VERSION,
      provider: providerId,
      tmdbId: normalizedTmdbId,
      mediaType: normalizedMediaType,
      season: normalizedSeason,
      episode: normalizedEpisode
    });

    const cached = await this.getCachedResult(cacheKey);

    if (cached) {
      logger.info('provider cache hit', {
        provider: providerId,
        tmdbId: normalizedTmdbId,
        mediaType: normalizedMediaType,
        resultCount: cached.length
      });
      return cached;
    }

    const cooldownState = this.providerHealth.get(providerId);

    if (cooldownState?.cooldownUntil && cooldownState.cooldownUntil > Date.now()) {
      logger.warn('provider skipped due to cooldown', {
        provider: providerId,
        tmdbId: normalizedTmdbId,
        mediaType: normalizedMediaType,
        cooldownUntil: new Date(cooldownState.cooldownUntil).toISOString()
      });
      return [];
    }

    const hostCooldownState = this.providerHostHealth.get(providerHostKey);

    if (hostCooldownState?.cooldownUntil && hostCooldownState.cooldownUntil > Date.now()) {
      logger.warn('provider skipped due to host cooldown', {
        provider: providerId,
        hostKey: providerHostKey,
        tmdbId: normalizedTmdbId,
        mediaType: normalizedMediaType,
        cooldownUntil: new Date(hostCooldownState.cooldownUntil).toISOString()
      });
      return [];
    }

    if (this.inFlight.has(cacheKey)) {
      return this.inFlight.get(cacheKey);
    }

    const execution = this.executeProviderQuery({
      cacheKey,
      providerId,
      providerConfig,
      providerHostKey,
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
    providerConfig,
    providerHostKey,
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
        this.withProviderHostSlot(providerHostKey, () => this.invokeProvider(providerConfig, providerId, {
          tmdbId: normalizedTmdbId,
          mediaType: normalizedMediaType,
          season: normalizedSeason,
          episode: normalizedEpisode
        })),
        timeoutPromise
      ]);

      if (!Array.isArray(streams)) {
        throw createHttpError(502, `Provider ${providerId} returned an invalid stream payload`);
      }

      const normalizedStreams = streams
        .map((stream) => sanitizeProviderStream(stream))
        .filter(Boolean);

      if (normalizedStreams.length !== streams.length) {
        logger.warn('provider returned invalid streams', {
          provider: providerId,
          tmdbId: normalizedTmdbId,
          mediaType: normalizedMediaType,
          droppedCount: streams.length - normalizedStreams.length
        });
      }

      await this.setCachedResult(cacheKey, normalizedStreams, providerId);
      this.providerHealth.delete(providerId);
      this.providerHostHealth.delete(providerHostKey);
      logger.info('provider scrape finished', {
        provider: providerId,
        hostKey: providerHostKey,
        tmdbId: normalizedTmdbId,
        mediaType: normalizedMediaType,
        resultCount: normalizedStreams.length
      });

      return normalizedStreams;
    } catch (error) {
      if (error?.statusCode === 504) {
        this.recordProviderFailure(providerId);
        this.recordProviderHostFailure(providerHostKey);
        logger.warn('provider scrape timed out', {
          provider: providerId,
          hostKey: providerHostKey,
          tmdbId: normalizedTmdbId,
          mediaType: normalizedMediaType
        });
        await this.setCachedResult(cacheKey, [], providerId);
        return [];
      }

      this.recordProviderFailure(providerId);
      this.recordProviderHostFailure(providerHostKey);
      logger.error('provider scrape failed', {
        provider: providerId,
        hostKey: providerHostKey,
        tmdbId: normalizedTmdbId,
        mediaType: normalizedMediaType,
        error
      });
      await this.setCachedResult(cacheKey, [], providerId);
      return [];
    } finally {
      clearTimeout(timeoutId);
    }
  }

  getProviderHostKey(providerId) {
    return String(providerId || '')
      .trim()
      .toLowerCase()
      .replace(/(?:_tv|-tv)$/u, '');
  }

  async withProviderHostSlot(hostKey, fn) {
    const normalizedHostKey = String(hostKey || '').trim().toLowerCase() || 'default';

    while ((this.providerHostInflight.get(normalizedHostKey) || 0) >= config.PROVIDER_HOST_MAX_INFLIGHT) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    this.providerHostInflight.set(
      normalizedHostKey,
      (this.providerHostInflight.get(normalizedHostKey) || 0) + 1
    );

    try {
      return await fn();
    } finally {
      const remaining = Math.max((this.providerHostInflight.get(normalizedHostKey) || 1) - 1, 0);

      if (remaining === 0) {
        this.providerHostInflight.delete(normalizedHostKey);
      } else {
        this.providerHostInflight.set(normalizedHostKey, remaining);
      }
    }
  }

  recordProviderFailure(providerId) {
    const now = Date.now();
    const current = this.providerHealth.get(providerId) || { failures: 0, cooldownUntil: 0 };
    const failures = current.failures + 1;
    const nextState = {
      failures,
      cooldownUntil: failures >= config.PROVIDER_FAILURE_THRESHOLD
        ? now + (config.PROVIDER_COOLDOWN_SECONDS * 1000)
        : 0
    };

    this.providerHealth.set(providerId, nextState);

    if (nextState.cooldownUntil > now) {
      logger.warn('provider entered cooldown', {
        provider: providerId,
        failures,
        cooldownUntil: new Date(nextState.cooldownUntil).toISOString()
      });
    }
  }

  recordProviderHostFailure(hostKey) {
    const normalizedHostKey = String(hostKey || '').trim().toLowerCase() || 'default';
    const now = Date.now();
    const current = this.providerHostHealth.get(normalizedHostKey) || { failures: 0, cooldownUntil: 0 };
    const failures = current.failures + 1;
    const nextState = {
      failures,
      cooldownUntil: failures >= config.PROVIDER_HOST_FAILURE_THRESHOLD
        ? now + (config.PROVIDER_HOST_COOLDOWN_SECONDS * 1000)
        : 0
    };

    this.providerHostHealth.set(normalizedHostKey, nextState);

    if (nextState.cooldownUntil > now) {
      logger.warn('provider host entered cooldown', {
        hostKey: normalizedHostKey,
        failures,
        cooldownUntil: new Date(nextState.cooldownUntil).toISOString()
      });
    }
  }

  async getCachedResult(cacheKey) {
    const entry = this.resultCache.get(cacheKey);

    if (!entry) {
      return this.getDiskCachedResult(cacheKey);
    }

    if (entry.expiresAt <= Date.now()) {
      this.resultCache.delete(cacheKey);
      return this.getDiskCachedResult(cacheKey);
    }

    return copyStreams(entry.streams);
  }

  async getDiskCachedResult(cacheKey) {
    const cachePath = this.getCacheFilePath(cacheKey);

    try {
      const payload = JSON.parse(await readFile(cachePath, 'utf8'));

      if (!payload || payload.expiresAt <= Date.now() || !Array.isArray(payload.streams)) {
        await rm(cachePath, { force: true });
        return null;
      }

      const entry = {
        streams: copyStreams(payload.streams),
        expiresAt: payload.expiresAt
      };

      this.resultCache.set(cacheKey, entry);
      logger.info('provider disk cache hit', {
        cacheKey: this.hashCacheKey(cacheKey),
        resultCount: payload.streams.length
      });
      return copyStreams(payload.streams);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn('provider disk cache read failed', {
          cacheKey: this.hashCacheKey(cacheKey),
          error
        });
      }

      return null;
    }
  }

  async setCachedResult(cacheKey, streams, providerId = null) {
    if (streams.length === 0 && providerId && NO_EMPTY_CACHE_PROVIDERS.has(providerId)) {
      this.resultCache.delete(cacheKey);
      try {
        await rm(this.getCacheFilePath(cacheKey), { force: true });
      } catch {}
      return;
    }

    const entry = {
      streams: copyStreams(streams),
      expiresAt: Date.now() + config.PROVIDER_CACHE_TTL_SECONDS * 1000
    };

    this.resultCache.set(cacheKey, entry);

    try {
      await writeFile(this.getCacheFilePath(cacheKey), JSON.stringify(entry));
    } catch (error) {
      logger.warn('provider disk cache write failed', {
        cacheKey: this.hashCacheKey(cacheKey),
        error
      });
    }
  }

  normalizeProviders(providers) {
    const requestedProviders = Array.isArray(providers) ? providers : this.getProviderOrder();

    return requestedProviders
      .map((provider) => String(provider || '').trim().toLowerCase())
      .filter(Boolean)
      .filter((provider, index, list) => list.indexOf(provider) === index)
      .filter((provider) => this.providers.has(provider));
  }

  getProviderOrderBase() {
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

  getProviderOrder(contentProfile = null, requestedProviders = null) {
    const baseOrder = this.getProviderOrderBase();
    const baseIndex = new Map(baseOrder.map((providerId, index) => [providerId, index]));
    const candidates = Array.isArray(requestedProviders)
      ? requestedProviders
        .map((provider) => String(provider || '').trim().toLowerCase())
        .filter(Boolean)
        .filter((provider, index, list) => list.indexOf(provider) === index)
        .filter((provider) => this.providers.has(provider))
      : baseOrder;

    if (!contentProfile || !Array.isArray(contentProfile.tags) || contentProfile.tags.length === 0) {
      return candidates;
    }

    return [...candidates].sort((left, right) => {
      const boostDelta = getProviderContentBoost(right, contentProfile) - getProviderContentBoost(left, contentProfile);

      if (boostDelta !== 0) {
        return boostDelta;
      }

      return (baseIndex.get(left) ?? Number.MAX_SAFE_INTEGER) - (baseIndex.get(right) ?? Number.MAX_SAFE_INTEGER);
    });
  }

  async getTmdbMetadata({ tmdbId, mediaType }) {
    const normalizedTmdbId = toOptionalInteger(tmdbId);
    const normalizedMediaType = String(mediaType || 'movie').trim().toLowerCase() === 'tv' ? 'tv' : 'movie';

    if (!normalizedTmdbId) {
      return null;
    }

    const cacheKey = `${normalizedMediaType}:${normalizedTmdbId}`;
    const cached = this.tmdbMetadataCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    if (this.tmdbMetadataInFlight.has(cacheKey)) {
      return this.tmdbMetadataInFlight.get(cacheKey);
    }

    const request = (async () => {
      const response = await fetch(`https://api.themoviedb.org/3/${normalizedMediaType}/${normalizedTmdbId}?api_key=${config.TMDB_API_KEY}`);

      if (!response.ok) {
        throw new Error(`TMDB metadata HTTP ${response.status}`);
      }

      const metadata = await response.json();

      this.tmdbMetadataCache.set(cacheKey, {
        value: metadata,
        expiresAt: Date.now() + TMDB_METADATA_CACHE_TTL_MS
      });

      return metadata;
    })();

    this.tmdbMetadataInFlight.set(cacheKey, request);

    try {
      return await request;
    } finally {
      this.tmdbMetadataInFlight.delete(cacheKey);
    }
  }

  buildContentProfile(metadata, mediaType) {
    if (!metadata || typeof metadata !== 'object') {
      return null;
    }

    const originalLanguage = String(metadata.original_language || '').toLowerCase();
    const genreNames = new Set(
      Array.isArray(metadata.genres)
        ? metadata.genres.map((genre) => String(genre?.name || '').toLowerCase()).filter(Boolean)
        : []
    );
    const originCountries = new Set(
      [
        ...(Array.isArray(metadata.origin_country) ? metadata.origin_country : []),
        ...(Array.isArray(metadata.production_countries)
          ? metadata.production_countries.map((country) => country?.iso_3166_1)
          : [])
      ]
        .map((country) => String(country || '').toUpperCase())
        .filter(Boolean)
    );
    const tags = [];
    const isAnimation = genreNames.has('animation');
    const isAnime = isAnimation && (originalLanguage === 'ja' || originCountries.has('JP'));

    if (isAnime) {
      tags.push('anime');
    }

    if (!isAnime && (originalLanguage === 'ko' || originCountries.has('KR'))) {
      tags.push('kdrama');
    }

    if (INDIAN_LANGUAGES.has(originalLanguage) || originCountries.has('IN')) {
      tags.push('indian');
    }

    if (originalLanguage === 'tr' || originCountries.has('TR')) {
      tags.push('turkish');
    }

    if (originalLanguage === 'pt' || originCountries.has('BR') || originCountries.has('PT')) {
      tags.push('portuguese');
    }

    if (originalLanguage === 'es') {
      tags.push('spanish');
    }

    return {
      mediaType,
      originalLanguage,
      originCountries: [...originCountries],
      genreNames: [...genreNames],
      tags
    };
  }

  loadProviderModule(providerConfig, providerId = providerConfig.id) {
    if (this.moduleCache.has(providerConfig.modulePath)) {
      return this.moduleCache.get(providerConfig.modulePath);
    }

    let loadedModule;

    try {
      loadedModule = require(providerConfig.modulePath);
    } catch (error) {
      logger.error('provider module load failed', {
        provider: providerId,
        modulePath: providerConfig.modulePath,
        error
      });
      throw createHttpError(500, `Provider ${providerId} could not be loaded`);
    }

    if (!loadedModule || typeof loadedModule.getStreams !== 'function') {
      throw createHttpError(500, `Provider ${providerId} does not export getStreams`);
    }

    this.moduleCache.set(providerConfig.modulePath, loadedModule);
    return loadedModule;
  }

  async invokeProvider(providerConfig, providerId, params) {
    if (providerConfig.invocation === 'subprocess') {
      return this.invokeProviderSubprocess(providerConfig, providerId, params);
    }

    const providerModule = this.loadProviderModule(providerConfig, providerId);
    return Promise.resolve().then(() => providerModule.getStreams(
      params.tmdbId,
      params.mediaType,
      params.season,
      params.episode
    ));
  }

  async invokeProviderSubprocess(providerConfig, providerId, params) {
    const { stdout } = await execFileAsync(process.execPath, [
      providerConfig.runnerPath,
      String(params.tmdbId),
      String(params.mediaType),
      params.season === null ? '' : String(params.season),
      params.episode === null ? '' : String(params.episode)
    ], {
      cwd: process.cwd(),
      timeout: (config.PROVIDER_TIMEOUT_SECONDS * 1000) + 2000,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env
    });

    try {
      return JSON.parse(stdout || '[]');
    } catch (error) {
      logger.warn('provider subprocess returned invalid JSON', {
        provider: providerId,
        error
      });
      return [];
    }
  }

  getCacheFilePath(cacheKey) {
    return path.join(this.providerCacheDir, `${this.hashCacheKey(cacheKey)}.json`);
  }

  hashCacheKey(cacheKey) {
    return crypto.createHash('sha256').update(cacheKey).digest('hex');
  }

  async removeExpiredDiskEntries() {
    let entries = [];

    try {
      entries = await readdir(this.providerCacheDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
      return;
    }

    await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map(async (entry) => {
        const filePath = path.join(this.providerCacheDir, entry.name);

        try {
          const payload = JSON.parse(await readFile(filePath, 'utf8'));

          if (!payload || payload.expiresAt <= Date.now()) {
            await rm(filePath, { force: true });
          }
        } catch {
          await rm(filePath, { force: true });
        }
      }));
  }
}
