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
const PROVIDER_PRIORITY = ['vidlink', 'videasy', 'hdhub4u', 'torrent-scraper'];
const STREMIO_EXCLUDED_PROVIDERS = new Set(['torrent-scraper']);
const PROVIDER_RELIABILITY_SCORES = Object.freeze({
  vidlink: 120,
  videasy: 115,
  hdhub4u: 110,
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

const toProviderScore = (providerId, providerOrder) => {
  if (Object.hasOwn(PROVIDER_RELIABILITY_SCORES, providerId)) {
    return PROVIDER_RELIABILITY_SCORES[providerId];
  }

  const index = providerOrder.indexOf(providerId);

  if (index === -1) {
    return 0;
  }

  return Math.max(60 - index, 1);
};

const rankStream = (stream, providerOrder) => {
  const providerId = String(stream.provider || '').toLowerCase();
  const qualityScore = toQualityScore(stream.quality);
  const transportScore = stream.url ? toTransportScore(stream.url) : stream.magnet ? 6 : 10;
  const headerScore = toHeaderScore(stream.headers);
  const providerScore = toProviderScore(providerId, providerOrder);

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

  getStremioProviderOrder(requestedProviders = null) {
    const candidates = this.normalizeProviders(
      requestedProviders && requestedProviders.length > 0 ? requestedProviders : this.getProviderOrder()
    );

    return candidates.filter((providerId) => !STREMIO_EXCLUDED_PROVIDERS.has(providerId));
  }

  async getAggregateStreams({ providers = null, ...rest }) {
    const normalizedProviders = this.normalizeProviders(providers);

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
      const scoreDelta = rankStream(right, normalizedProviders) - rankStream(left, normalizedProviders);

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
    const normalizedProviders = this.getStremioProviderOrder(
      providers && providers.length > 0 ? providers : null
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
      const scoreDelta = rankStream(right, normalizedProviders) - rankStream(left, normalizedProviders);

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
