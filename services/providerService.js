import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
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
const providerAbortSignalStorage = new AsyncLocalStorage();
const nativeFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
const getPrivateProviderSettingsKey = (providerId, privateProviderSettings = null) => {
  if (providerId !== 'showbox') {
    return '';
  }

  const uiToken = String(privateProviderSettings?.febboxUiCookie || '').trim();

  if (!uiToken) {
    return '';
  }

  return crypto.createHash('sha1').update(uiToken).digest('hex');
};
const getProviderCacheVersion = (providerId) => {
  if (providerId === '4khdhub' || providerId === '4khdhub_tv') {
    return '36';
  }

  if (providerId === 'rgshows') {
    return '24';
  }

  if (providerId === 'moviesmod') {
    return '25';
  }

  if (providerId === 'vixsrc') {
    return '28';
  }

  if (providerId === 'hdhub4u') {
    return '29';
  }

  if (providerId === 'kisskh') {
    return '30';
  }

  if (providerId === 'latino-lamovie') {
    return '32';
  }

  if (providerId === 'latino-cinecalidad') {
    return '31';
  }

  if (providerId === 'uhdmovies') {
    return '34';
  }

  if (providerId === 'allyoucanwatch') {
    return '39';
  }

  return '23';
};
const prioritizePrivateTokenProviders = (providers, privateProviderSettings = null) => {
  const ordered = Array.isArray(providers) ? [...providers] : [];
  const hasFebboxUiCookie = Boolean(String(privateProviderSettings?.febboxUiCookie || '').trim());

  if (hasFebboxUiCookie && ordered.includes('showbox')) {
    ordered.splice(ordered.indexOf('showbox'), 1);
    ordered.unshift('showbox');
  }

  return ordered;
};

if (nativeFetch && !globalThis.fetch.__nebulaProviderAbortWrapped) {
  const fetchWithProviderAbort = (input, init = {}) => {
    const providerSignal = providerAbortSignalStorage.getStore();

    if (!providerSignal) {
      return nativeFetch(input, init);
    }

    const nextInit = init && typeof init === 'object' ? { ...init } : {};

    if (nextInit.signal) {
      nextInit.signal = AbortSignal.any
        ? AbortSignal.any([nextInit.signal, providerSignal])
        : nextInit.signal;
    } else {
      nextInit.signal = providerSignal;
    }

    return nativeFetch(input, nextInit);
  };

  Object.defineProperty(fetchWithProviderAbort, '__nebulaProviderAbortWrapped', {
    value: true
  });
  globalThis.fetch = fetchWithProviderAbort;
}

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
const IGNORED_PROVIDER_IDS = new Set(['test', 'test2']);
const NO_EMPTY_CACHE_PROVIDERS = new Set([
  'allyoucanwatch',
  '4khdhub',
  '4khdhub_tv',
  'anime-sama',
  'animekai',
  'animesalt',
  'cinestream',
  'moviesmod',
  'torrent-scraper',
  'vixsrc'
]);
const PRIORITY_EMPTY_CACHE_PROVIDERS = new Set([
  '4khdhub',
  '4khdhub_tv',
  'allyoucanwatch',
  'hdhub4u',
  'uhdmovies',
  'flixindia',
  'tamilian',
  'streamflix',
  'moviebox',
  'vidlink'
]);
const PRIORITY_COOLDOWN_HOSTS = new Set(['4khdhub', 'hdhub4u']);
const PROVIDER_HOST_MAX_INFLIGHT_OVERRIDES = Object.freeze({
  allyoucanwatch: 1,
  '4khdhub': 2,
  hdhub4u: 2
});
const PROVIDER_TIMEOUT_OVERRIDES_SECONDS = Object.freeze({
  '4khdhub': 25,
  '4khdhub_tv': 25,
  allyoucanwatch: 30,
  cinestream: 20,
  hdhub4u: 25,
  uhdmovies: 25,
  moviebox: 20,
  moviesmod: 40,
  rgshows: 20,
  streamflix: 20,
  vidlink: 20,
  videasy: 20,
  animekai: 25,
  'latino-lamovie': 25,
  'latino-cinecalidad': 25,
  'latino-embed69': 20,
  'latino-xupalace': 20,
  'latino-seriesmetro': 20,
  'arabic-faselhd': 30,
  'arabic-kirmzi': 25,
  'arabic-witanime': 30,
  'arabic-animecloud': 30,
  'arabic-cineby': 25
});
const getProviderTimeoutSeconds = (providerId) =>
  PROVIDER_TIMEOUT_OVERRIDES_SECONDS[providerId] || config.PROVIDER_TIMEOUT_SECONDS;
const PROVIDER_PRIORITY = [
  '4khdhub',
  '4khdhub_tv',
  'uhdmovies',
  'hdhub4u',
  'vidlink',
  'cinestream',
  'moviebox',
  'allyoucanwatch',
  'kisskh',
  'onlykdrama',
  'rgshows',
  'streamflix',
  'netmirror',
  'videasy',
  'tamilian',
  'streamflix_eng',
  'moviesmod',
  'hdmovie2',
  'movix',
  'flixindia',
  'isaidub',
  'allwish',
  'allmovieland',
  'vidmody-tr',
  'turkish-m3u',
  'rectv-tr',
  'diziyou',
  'it-streamingcommunity',
  'it-guardahd',
  'it-guardaserie',
  'it-guardoserie',
  'it-cc',
  'it-animeunity',
  'it-animeworld',
  'it-animesaturn',
  'latino-lamovie',
  'latino-embed69',
  'latino-cinecalidad',
  'latino-xupalace',
  'latino-seriesmetro',
  'arabic-faselhd',
  'arabic-cineby',
  'arabic-witanime',
  'arabic-animecloud',
  'arabic-kirmzi',
  'torrent-scraper'
];
const STREMIO_EXCLUDED_PROVIDERS = new Set(['torrent-scraper']);
const WEB_READY_FALLBACK_PROVIDERS = Object.freeze(['moviebox', 'streamflix', 'videasy', 'vidlink', 'cinestream']);
const DEFAULT_DIVERSITY_FALLBACK_PROVIDERS = Object.freeze(['moviebox', 'streamflix', 'videasy', 'rgshows']);
const UNKNOWN_TV_PROFILE_FALLBACK_PROVIDERS = Object.freeze(['animeworld', 'animesalt', 'moviebox']);
const PRIMARY_FAST_PROVIDER_IDS = new Set(['4khdhub', '4khdhub_tv', 'uhdmovies', 'hdhub4u', 'flixindia', 'tamilian']);
const BROKEN_ANIME_FAST_PROVIDERS = new Set(['anime-sama', 'animekai']);
const ANIME_SPECIALIST_PROVIDERS = new Set([
  'animesalt',
  'animeworld',
  'it-animeunity',
  'it-animeworld',
  'it-animesaturn',
  'arabic-witanime',
  'arabic-animecloud',
  'kisskh'
]);
const TMDB_METADATA_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TMDB_METADATA_RETRY_DELAYS_MS = Object.freeze([250, 750]);
const CONTENT_PROVIDER_BOOSTS = Object.freeze({
  anime: Object.freeze({
    animeworld: 190,
    animesalt: 180,
    moviebox: 172,
    '4khdhub_tv': 168,
    '4khdhub': 166,
    hdhub4u: 150,
    'it-animeunity': 120,
    'it-animeworld': 115,
    'it-animesaturn': 110,
    'arabic-witanime': 105,
    'arabic-animecloud': 100,
    'arabic-cineby': 95,
    kisskh: 92,
    'anime-sama': 40,
    animekai: 35
  }),
  asian_drama: Object.freeze({
    kisskh: 205,
    onlykdrama: 70,
    showbox: 45
  }),
  kdrama: Object.freeze({
    kisskh: 190,
    onlykdrama: 180,
    showbox: 40
  }),
  indian: Object.freeze({
    '4khdhub': 230,
    '4khdhub_tv': 225,
    uhdmovies: 223,
    hdhub4u: 220,
    flixindia: 205,
    tamilian: 165,
    isaidub: 155,
    hindmoviez: 145,
    streamflix: 110,
    streamflix_eng: 105,
    moviesmod: 100,
    allwish: 80,
    allmovieland: 70
  }),
  turkish: Object.freeze({
    'vidmody-tr': 195,
    'turkish-m3u': 190,
    'rectv-tr': 185,
    diziyou: 180,
    sinemacx: 170,
    cinemacity: 120
  }),
  italian: Object.freeze({
    'it-streamingcommunity': 195,
    'it-guardahd': 185,
    'it-guardaserie': 180,
    'it-guardoserie': 175,
    'it-cc': 155,
    'it-animeunity': 140,
    'it-animeworld': 135,
    'it-animesaturn': 130
  }),
  portuguese: Object.freeze({
    brazucaplay: 180
  }),
  spanish: Object.freeze({
    'latino-lamovie': 195,
    'latino-cinecalidad': 190,
    'latino-embed69': 45,
    'latino-xupalace': 40,
    'latino-seriesmetro': 35,
    lamovie: 170,
    purstream: 130
  }),
  arabic: Object.freeze({
    'arabic-faselhd': 195,
    'arabic-cineby': 185,
    'arabic-witanime': 175,
    'arabic-animecloud': 170,
    'arabic-kirmzi': 150
  })
});
const PROVIDER_RELIABILITY_SCORES = Object.freeze({
  '4khdhub': 165,
  '4khdhub_tv': 160,
  hdhub4u: 150,
  uhdmovies: 145,
  vidlink: 120,
  cinestream: 118,
  videasy: 115,
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
  purstream: 86,
  'vidmody-tr': 104,
  'turkish-m3u': 102,
  'rectv-tr': 100,
  diziyou: 98,
  'it-streamingcommunity': 106,
  'it-guardahd': 102,
  'it-guardaserie': 100,
  'it-guardoserie': 98,
  'it-cc': 94,
  'it-animeunity': 96,
  'it-animeworld': 94,
  'it-animesaturn': 92,
  'latino-lamovie': 106,
  'latino-embed69': 104,
  'latino-cinecalidad': 102,
  'latino-xupalace': 100,
  'latino-seriesmetro': 98,
  'arabic-faselhd': 106,
  'arabic-cineby': 104,
  'arabic-witanime': 100,
  'arabic-animecloud': 98,
  'arabic-kirmzi': 94
});
const INDIAN_LANGUAGES = new Set(['ta', 'te', 'hi', 'ml', 'kn']);
const ASIAN_DRAMA_LANGUAGES = new Set(['ko', 'ja', 'zh', 'th']);
const ASIAN_DRAMA_COUNTRIES = new Set(['KR', 'JP', 'CN', 'TW', 'TH', 'HK']);
const ARABIC_COUNTRIES = new Set(['AE', 'BH', 'DZ', 'EG', 'IQ', 'JO', 'KW', 'LB', 'MA', 'OM', 'PS', 'QA', 'SA', 'SY', 'TN', 'YE']);
const PROVIDER_LABEL_OVERRIDES = Object.freeze({
  'it-streamingcommunity': 'StreamingCommunity IT',
  'it-guardahd': 'GuardaHD',
  'it-guardaserie': 'GuardaSerie',
  'it-guardoserie': 'GuardoSerie',
  'it-cc': 'CC IT',
  'it-animeunity': 'AnimeUnity IT',
  'it-animeworld': 'AnimeWorld IT',
  'it-animesaturn': 'AnimeSaturn',
  'latino-lamovie': 'LaMovie Latino',
  'latino-cinecalidad': 'CineCalidad',
  'latino-embed69': 'Embed69 Latino',
  'latino-xupalace': 'XuPalace',
  'latino-seriesmetro': 'SeriesMetro',
  'arabic-faselhd': 'FaselHD',
  'arabic-kirmzi': 'Kirmzi',
  'arabic-witanime': 'WitAnime',
  'arabic-animecloud': 'AnimeCloud Arabic',
  'arabic-cineby': 'Cineby Arabic'
});

const toLabel = (providerId) =>
  PROVIDER_LABEL_OVERRIDES[providerId]
  || providerId
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
const serializeStreams = (streams) => JSON.stringify(Array.isArray(streams) ? streams : []);
const deserializeStreams = (payload) => {
  if (typeof payload !== 'string' || !payload) {
    return [];
  }

  try {
    const parsed = JSON.parse(payload);
    return Array.isArray(parsed) ? copyStreams(parsed) : [];
  } catch {
    return [];
  }
};
const getSerializedApproxBytes = (payload) => Buffer.byteLength(String(payload || ''), 'utf8');

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

const pruneMapByApproxBytes = (map, maxBytes, getEntryBytes = (entry) => entry?.approxBytes || 0) => {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || map.size === 0) {
    return;
  }

  let totalBytes = 0;

  for (const entry of map.values()) {
    totalBytes += Math.max(0, Number(getEntryBytes(entry)) || 0);
  }

  while (totalBytes > maxBytes && map.size > 0) {
    const oldestKey = map.keys().next().value;

    if (oldestKey === undefined) {
      break;
    }

    const oldestEntry = map.get(oldestKey);
    totalBytes -= Math.max(0, Number(getEntryBytes(oldestEntry)) || 0);
    map.delete(oldestKey);
  }
};

const getAbortReason = (signal, fallbackMessage = 'Provider query aborted') => {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }

  return createHttpError(504, fallbackMessage);
};

const waitForProviderSlot = (delayMs, signal) => {
  if (signal?.aborted) {
    return Promise.reject(getAbortReason(signal));
  }

  return new Promise((resolve, reject) => {
    let timeoutId;

    const cleanup = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(getAbortReason(signal));
    };

    timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    timeoutId.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

const getProviderFailureThreshold = (providerId) =>
  PRIORITY_EMPTY_CACHE_PROVIDERS.has(providerId)
    ? config.PROVIDER_FAILURE_THRESHOLD * 4
    : config.PROVIDER_FAILURE_THRESHOLD;

const getProviderCooldownMs = (providerId) =>
  (PRIORITY_EMPTY_CACHE_PROVIDERS.has(providerId) ? 30 : config.PROVIDER_COOLDOWN_SECONDS) * 1000;

const getProviderHostFailureThreshold = (hostKey) =>
  PRIORITY_COOLDOWN_HOSTS.has(hostKey)
    ? config.PROVIDER_HOST_FAILURE_THRESHOLD * 4
    : config.PROVIDER_HOST_FAILURE_THRESHOLD;

const getProviderHostCooldownMs = (hostKey) =>
  (PRIORITY_COOLDOWN_HOSTS.has(hostKey) ? 30 : config.PROVIDER_HOST_COOLDOWN_SECONDS) * 1000;

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

const mergeAndRankProviderStreams = (settledResults, providerOrder, contentProfile = null, limit = Infinity) => {
  const mergedStreams = [];
  const seenSources = new Set();

  for (const result of settledResults) {
    if (!result) {
      continue;
    }

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
    const scoreDelta = rankStream(right, providerOrder, contentProfile) - rankStream(left, providerOrder, contentProfile);

    if (scoreDelta !== 0) {
      return scoreDelta;
    }

    return String(left.name || left.title || left.url).localeCompare(
      String(right.name || right.title || right.url)
    );
  });

  return Number.isFinite(limit)
    ? mergedStreams.slice(0, limit)
    : mergedStreams;
};

const applyPerProviderSoftLimit = (streams, limit, perProviderSoftLimit = Infinity) => {
  if (!Number.isFinite(limit)) {
    return streams;
  }

  if (!Number.isFinite(perProviderSoftLimit) || perProviderSoftLimit < 1) {
    return streams.slice(0, limit);
  }

  const selected = [];
  const deferred = [];
  const providerCounts = new Map();

  for (const stream of streams) {
    const providerId = String(stream.provider || '').trim().toLowerCase() || 'unknown';
    const count = providerCounts.get(providerId) || 0;

    if (count < perProviderSoftLimit) {
      providerCounts.set(providerId, count + 1);
      selected.push(stream);
    } else {
      deferred.push(stream);
    }

    if (selected.length >= limit) {
      return selected;
    }
  }

  for (const stream of deferred) {
    selected.push(stream);
    if (selected.length >= limit) {
      break;
    }
  }

  return selected;
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    this.providerRuntime = new Map();
    this.providerGlobalInflight = 0;
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
    const providerStatuses = this.getProviderStatusSnapshot(now);

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
      activeProviderExecutions: this.providerGlobalInflight,
      providerCacheDir: this.providerCacheDir,
      coolingDownProviders,
      coolingDownHosts,
      providers: providerStatuses
    };
  }

  updateProviderRuntime(providerId, patch) {
    const current = this.providerRuntime.get(providerId) || {
      totalRequests: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      consecutiveFailures: 0,
      lastResultCount: null,
      lastDurationMs: null,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastCacheHitAt: null,
      lastError: null,
      running: false
    };

    this.providerRuntime.set(providerId, {
      ...current,
      ...patch
    });
  }

  getProviderStatusSnapshot(now = Date.now()) {
    return this.getProviderOrder().map((providerId) => {
      const provider = this.providers.get(providerId);
      const hostKey = this.getProviderHostKey(providerId);
      const runtime = this.providerRuntime.get(providerId) || {};
      const health = this.providerHealth.get(providerId) || {};
      const hostHealth = this.providerHostHealth.get(hostKey) || {};
      const providerCooldownUntil = health.cooldownUntil || 0;
      const hostCooldownUntil = hostHealth.cooldownUntil || 0;
      const cooldownUntil = Math.max(providerCooldownUntil, hostCooldownUntil);
      const activeRequests = this.providerHostInflight.get(hostKey) || 0;
      let status = 'idle';

      if (runtime.running) {
        status = 'running';
      } else if (cooldownUntil > now) {
        status = 'cooldown';
      } else if ((runtime.consecutiveFailures || 0) > 0) {
        status = 'failing';
      } else if (runtime.lastResultCount === 0) {
        status = 'empty';
      } else if (Number.isFinite(runtime.lastResultCount)) {
        status = 'ok';
      } else if (runtime.lastCacheHitAt) {
        status = 'cache-hit';
      }

      return {
        id: providerId,
        label: provider?.label || toLabel(providerId),
        hostKey,
        status,
        activeRequests,
        failures: health.failures || 0,
        hostFailures: hostHealth.failures || 0,
        cooldownUntil: cooldownUntil > now ? cooldownUntil : 0,
        lastStartedAt: runtime.lastStartedAt || null,
        lastFinishedAt: runtime.lastFinishedAt || null,
        lastCacheHitAt: runtime.lastCacheHitAt || null,
        lastResultCount: Number.isFinite(runtime.lastResultCount) ? runtime.lastResultCount : null,
        lastDurationMs: Number.isFinite(runtime.lastDurationMs) ? runtime.lastDurationMs : null,
        lastError: runtime.lastError || null,
        totalRequests: runtime.totalRequests || 0,
        totalSuccesses: runtime.totalSuccesses || 0,
        totalFailures: runtime.totalFailures || 0,
        consecutiveFailures: runtime.consecutiveFailures || 0
      };
    });
  }

  handleMemoryPressure({ critical = false } = {}) {
    if (critical) {
      this.resultCache.clear();
      this.tmdbMetadataCache.clear();
      return;
    }

    pruneMapByMaxEntries(this.resultCache, Math.max(50, Math.floor(config.PROVIDER_RESULT_MEMORY_CACHE_MAX_ENTRIES / 4)));
    pruneMapByApproxBytes(this.resultCache, Math.max(512 * 1024, Math.floor((config.PROVIDER_RESULT_MEMORY_CACHE_MAX_MB * 1024 * 1024) / 4)));
    pruneMapByMaxEntries(this.tmdbMetadataCache, Math.max(50, Math.floor(config.TMDB_METADATA_MEMORY_CACHE_MAX_ENTRIES / 4)));
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
    return {
      providers: normalizedProviders,
      tried,
      streams: mergeAndRankProviderStreams(settledResults, normalizedProviders, contentProfile)
    };
  }

  async getFastStreams({ providers = null, ...rest }) {
    const contentProfile = rest.contentProfile || await this.getContentProfile(rest);
    const orderedProviders = this.getStremioProviderOrder(
      providers && providers.length > 0 ? providers : null,
      contentProfile
    );
    const hasExplicitProviders = Array.isArray(providers) && providers.length > 0;
    const prioritizedProviders = prioritizePrivateTokenProviders(orderedProviders, rest.privateProviderSettings);
    const baseProviders = !hasExplicitProviders && Array.isArray(contentProfile?.tags) && contentProfile.tags.includes('anime')
      ? [
        ...prioritizedProviders.filter((providerId) => !BROKEN_ANIME_FAST_PROVIDERS.has(providerId)),
        ...prioritizedProviders.filter((providerId) => BROKEN_ANIME_FAST_PROVIDERS.has(providerId))
      ]
      : prioritizedProviders;
    const initialProviderLimit = hasExplicitProviders
      ? Math.min(baseProviders.length, Math.max(config.STREMIO_FAST_PROVIDER_LIMIT, 12))
      : config.STREMIO_FAST_PROVIDER_LIMIT;
    const normalizedProviders = baseProviders.slice(0, initialProviderLimit);

    if (!hasExplicitProviders && rest.streamOptions?.webReadyOnly) {
      for (const providerId of WEB_READY_FALLBACK_PROVIDERS) {
        if (baseProviders.includes(providerId) && !normalizedProviders.includes(providerId)) {
          normalizedProviders.push(providerId);
        }
      }
    } else if (!hasExplicitProviders) {
      for (const providerId of DEFAULT_DIVERSITY_FALLBACK_PROVIDERS) {
        if (baseProviders.includes(providerId) && !normalizedProviders.includes(providerId)) {
          normalizedProviders.push(providerId);
        }
      }

      if (!contentProfile && rest.mediaType === 'tv') {
        for (const providerId of UNKNOWN_TV_PROFILE_FALLBACK_PROVIDERS) {
          if (baseProviders.includes(providerId) && !normalizedProviders.includes(providerId)) {
            normalizedProviders.push(providerId);
          }
        }
      }
    }

    if (normalizedProviders.length === 0) {
      throw createHttpError(400, 'No valid providers were supplied for fast search');
    }

    const queuedProviders = [...normalizedProviders];
    const overflowProviders = baseProviders.filter((providerId) => !queuedProviders.includes(providerId));

    const earlyReturnTarget = Math.min(
      config.STREMIO_FAST_STREAM_LIMIT,
      config.STREMIO_FAST_EARLY_RETURN_STREAMS
    );
    const minCompletedProviders = Math.min(
      normalizedProviders.length,
      config.STREMIO_FAST_MIN_COMPLETED_PROVIDERS
    );
    const startedAt = Date.now();
    const explicitProviderWaitMs = hasExplicitProviders
      ? Math.min(
        30_000,
        Math.max(
          config.STREMIO_FAST_MAX_WAIT_MS,
          ...normalizedProviders.map((providerId) => (getProviderTimeoutSeconds(providerId) * 1000) + 2_000)
        )
      )
      : config.STREMIO_FAST_MAX_WAIT_MS;

    return await new Promise((resolve) => {
      const results = [];
      let nextIndex = 0;
      let running = 0;
      let completed = 0;
      let resolved = false;
      let deadlineTimer;
      let deadlineAt = startedAt + explicitProviderWaitMs;
      let extendedForFallbackExploration = false;
      let extendedForAnimeSpecialists = false;
      let extendedForSlowStart = false;
      const expansionChunkSize = Math.max(3, Math.min(6, config.STREMIO_FAST_PROVIDER_CONCURRENCY * 2));
      let lastExpansionCompleted = -1;
      const animeLeadProviders = normalizedProviders.slice(0, Math.min(normalizedProviders.length, 4));
      const animeLeadCount = animeLeadProviders.filter((providerId) => ANIME_SPECIALIST_PROVIDERS.has(providerId)).length;
      const shouldHoldForAnimeSpecialists = (
        Array.isArray(contentProfile?.tags) && contentProfile.tags.includes('anime')
      ) || (
        !hasExplicitProviders &&
        rest.mediaType === 'tv' &&
        animeLeadCount >= 2
      );

      let launchNext = () => {};
      let armDeadlineTimer = () => {};
      const getActiveFastConcurrency = () => {
        const baseConcurrency = config.STREMIO_FAST_PROVIDER_CONCURRENCY;
        if (
          (
            extendedForAnimeSpecialists ||
            (
              extendedForFallbackExploration &&
              !hasExplicitProviders &&
              !rest.streamOptions?.webReadyOnly
            )
          )
        ) {
          return Math.min(baseConcurrency + 2, 5);
        }
        return baseConcurrency;
      };

      const finalize = (reason) => {
        if (resolved) {
          return;
        }

        resolved = true;
        clearTimeout(deadlineTimer);

        const settledResults = results.filter(Boolean);
        const tried = queuedProviders.map((provider, index) => ({
          provider,
          count: Array.isArray(results[index]?.streams) ? results[index].streams.length : 0
        }));
        const rankedStreams = mergeAndRankProviderStreams(
          settledResults,
          queuedProviders,
          contentProfile,
          config.STREMIO_FAST_STREAM_LIMIT
        );
        const streams = !hasExplicitProviders && !rest.streamOptions?.webReadyOnly
          ? applyPerProviderSoftLimit(rankedStreams, config.STREMIO_FAST_STREAM_LIMIT, 4)
          : rankedStreams;

        if (reason !== 'all-complete') {
          logger.info('fast provider search returned early', {
            reason,
            completedProviders: completed,
            totalProviders: queuedProviders.length,
            streamCount: streams.length,
            elapsedMs: Date.now() - startedAt,
            tmdbId: rest.tmdbId,
            mediaType: rest.mediaType
          });
        }

        resolve({
          reason,
          providers: queuedProviders,
          tried,
          streams
        });
      };

      const maybeExpandProviderQueue = (streams) => {
        if (overflowProviders.length === 0) {
          return false;
        }

        const initialBatchDone =
          completed >= Math.min(initialProviderLimit, queuedProviders.length) ||
          (nextIndex >= Math.min(initialProviderLimit, queuedProviders.length) && running === 0);
        const shouldExpandForEmpty = completed >= minCompletedProviders && streams.length === 0;
        const shouldExpandForWeak = initialBatchDone && streams.length < earlyReturnTarget;

        if (!shouldExpandForEmpty && !shouldExpandForWeak) {
          return false;
        }

        if (lastExpansionCompleted === completed) {
          return false;
        }

        let addedProviders = 0;

        while (overflowProviders.length > 0 && addedProviders < expansionChunkSize) {
          queuedProviders.push(overflowProviders.shift());
          addedProviders += 1;
        }

        if (addedProviders > 0) {
          lastExpansionCompleted = completed;
          logger.info('fast provider search expanded', {
            addedProviders,
            queuedProviders: queuedProviders.length,
            completedProviders: completed,
            streamCount: streams.length,
            tmdbId: rest.tmdbId,
            mediaType: rest.mediaType
          });
        }

        return addedProviders > 0;
      };

      const maybeFinalize = () => {
        if (resolved) {
          return;
        }

        const settledResults = results.filter(Boolean);
        const rankedStreams = mergeAndRankProviderStreams(
          settledResults,
          queuedProviders,
          contentProfile,
          config.STREMIO_FAST_STREAM_LIMIT
        );
        const streams = !hasExplicitProviders && !rest.streamOptions?.webReadyOnly
          ? applyPerProviderSoftLimit(rankedStreams, config.STREMIO_FAST_STREAM_LIMIT, 4)
          : rankedStreams;
        const expanded = maybeExpandProviderQueue(streams);

        if (expanded) {
          launchNext();
          return;
        }

        const providersWithStreams = settledResults
          .filter((result) => Array.isArray(result.streams) && result.streams.length > 0)
          .map((result) => result.provider);
        const providerDiversity = new Set(providersWithStreams).size;
        const primaryFastProviderHit = providersWithStreams.some((providerId) => PRIMARY_FAST_PROVIDER_IDS.has(providerId));
        const allDone = completed >= queuedProviders.length || (nextIndex >= queuedProviders.length && running === 0);
        const animeSpecialistIndexes = shouldHoldForAnimeSpecialists
          ? queuedProviders
            .map((providerId, index) => ANIME_SPECIALIST_PROVIDERS.has(providerId) ? index : -1)
            .filter((index) => index !== -1)
          : [];
        const animeSpecialistPending = animeSpecialistIndexes.some((index) => !results[index]);
        const shouldHoldForDefaultFallbackExploration = !hasExplicitProviders
          && !rest.streamOptions?.webReadyOnly
          && !primaryFastProviderHit
          && (
            (streams.length > 0 && providerDiversity < 3) ||
            (streams.length === 0 && completed > 0)
          );
        const enoughStreams = streams.length >= earlyReturnTarget
          && completed >= minCompletedProviders
          && !shouldHoldForDefaultFallbackExploration
          && (!shouldHoldForAnimeSpecialists || !animeSpecialistPending);
        const deadlineReached = Date.now() >= deadlineAt;

        if (allDone) {
          finalize('all-complete');
          return;
        }

        if (enoughStreams) {
          finalize('enough-streams');
          return;
        }

        if (
          deadlineReached &&
          !extendedForSlowStart &&
          completed === 0 &&
          running > 0
        ) {
          extendedForSlowStart = true;
          deadlineAt = Date.now() + (hasExplicitProviders ? 8_000 : 4_000);
          armDeadlineTimer();
          logger.info('fast provider search extended for slow-start providers', {
            completedProviders: completed,
            runningProviders: running,
            totalProviders: queuedProviders.length,
            explicitProviders: hasExplicitProviders,
            boostedWaitMs: hasExplicitProviders ? 8_000 : 4_000,
            tmdbId: rest.tmdbId,
            mediaType: rest.mediaType
          });
          return;
        }

        if (
          deadlineReached &&
          shouldHoldForAnimeSpecialists &&
          animeSpecialistPending &&
          !extendedForAnimeSpecialists &&
          (running > 0 || nextIndex < queuedProviders.length || overflowProviders.length > 0)
        ) {
          extendedForAnimeSpecialists = true;
          deadlineAt = Date.now() + 8000;
          armDeadlineTimer();
          launchNext();
          logger.info('fast provider search extended for anime specialists', {
            completedProviders: completed,
            totalProviders: queuedProviders.length,
            streamCount: streams.length,
            animeLeadCount,
            boostedConcurrency: getActiveFastConcurrency(),
            tmdbId: rest.tmdbId,
            mediaType: rest.mediaType
          });
          return;
        }

        if (
          deadlineReached &&
          shouldHoldForDefaultFallbackExploration &&
          !extendedForFallbackExploration &&
          (running > 0 || nextIndex < queuedProviders.length || overflowProviders.length > 0)
        ) {
          extendedForFallbackExploration = true;
          deadlineAt = Date.now() + 8000;
          armDeadlineTimer();
          launchNext();
          logger.info('fast provider search extended for default fallback exploration', {
            completedProviders: completed,
            totalProviders: queuedProviders.length,
            streamCount: streams.length,
            providerDiversity,
            boostedConcurrency: getActiveFastConcurrency(),
            tmdbId: rest.tmdbId,
            mediaType: rest.mediaType
          });
          return;
        }

        if (deadlineReached && (streams.length > 0 || completed >= minCompletedProviders)) {
          finalize('deadline');
        }
      };

      launchNext = () => {
        if (resolved) {
          return;
        }

        while (running < getActiveFastConcurrency() && nextIndex < queuedProviders.length) {
          const index = nextIndex;
          const provider = queuedProviders[index];
          nextIndex += 1;
          running += 1;

          Promise.resolve()
            .then(() => this.getStreams({
              provider,
              ...rest
            }))
            .then((streams) => {
              results[index] = {
                provider,
                streams: Array.isArray(streams) ? streams : []
              };
            })
            .catch((error) => {
              logger.warn('fast provider search worker failed', {
                provider,
                tmdbId: rest.tmdbId,
                mediaType: rest.mediaType,
                error
              });
              results[index] = {
                provider,
                streams: []
              };
            })
            .finally(() => {
              running = Math.max(running - 1, 0);
              completed += 1;
              maybeFinalize();
              launchNext();
            });
        }

        maybeFinalize();
      };

      armDeadlineTimer = () => {
        clearTimeout(deadlineTimer);
        const waitMs = Math.max(1, deadlineAt - Date.now());
        deadlineTimer = setTimeout(() => {
          maybeFinalize();

          if (!resolved && Date.now() >= deadlineAt) {
            finalize('deadline');
          }
        }, waitMs);
        deadlineTimer.unref?.();
      };

      armDeadlineTimer();

      launchNext();
    });
  }

  async getStreams({ provider, tmdbId, mediaType = 'movie', season = null, episode = null, privateProviderSettings = null }) {
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
      version: getProviderCacheVersion(providerId),
      provider: providerId,
      tmdbId: normalizedTmdbId,
      mediaType: normalizedMediaType,
      season: normalizedSeason,
      episode: normalizedEpisode,
      privateProviderSettingsKey: getPrivateProviderSettingsKey(providerId, privateProviderSettings)
    });

    const cached = await this.getCachedResult(cacheKey);

    if (cached) {
      this.updateProviderRuntime(providerId, {
        lastCacheHitAt: Date.now()
      });
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
      normalizedEpisode,
      privateProviderSettings
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
    normalizedEpisode,
    privateProviderSettings
  }) {
    const startedAt = Date.now();
    const existingRuntime = this.providerRuntime.get(providerId) || {};
    this.updateProviderRuntime(providerId, {
      running: true,
      lastStartedAt: startedAt,
      lastError: null,
      totalRequests: (existingRuntime.totalRequests || 0) + 1
    });

    try {
      logger.info('provider scrape started', {
        provider: providerId,
        tmdbId: normalizedTmdbId,
        mediaType: normalizedMediaType
      });

      const providerPromise = this.withProviderGlobalSlot(
        () => this.withProviderHostSlot(providerHostKey, () => this.invokeProviderWithTimeout(providerConfig, providerId, {
          tmdbId: normalizedTmdbId,
          mediaType: normalizedMediaType,
          season: normalizedSeason,
          episode: normalizedEpisode,
          privateProviderSettings
        }))
      );

      const streams = await providerPromise;

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
      const successRuntime = this.providerRuntime.get(providerId) || {};
      this.updateProviderRuntime(providerId, {
        running: false,
        lastFinishedAt: Date.now(),
        lastDurationMs: Date.now() - startedAt,
        lastResultCount: normalizedStreams.length,
        lastError: null,
        totalSuccesses: (successRuntime.totalSuccesses || 0) + 1,
        consecutiveFailures: 0
      });
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
        const timeoutRuntime = this.providerRuntime.get(providerId) || {};
        this.updateProviderRuntime(providerId, {
          running: false,
          lastFinishedAt: Date.now(),
          lastDurationMs: Date.now() - startedAt,
          lastResultCount: 0,
          lastError: error.message || 'Provider timed out',
          totalFailures: (timeoutRuntime.totalFailures || 0) + 1,
          consecutiveFailures: (timeoutRuntime.consecutiveFailures || 0) + 1
        });
        logger.warn('provider scrape timed out', {
          provider: providerId,
          hostKey: providerHostKey,
          tmdbId: normalizedTmdbId,
          mediaType: normalizedMediaType
        });
        await this.deleteCachedResult(cacheKey);
        return [];
      }

      this.recordProviderFailure(providerId);
      this.recordProviderHostFailure(providerHostKey);
      const failureRuntime = this.providerRuntime.get(providerId) || {};
      this.updateProviderRuntime(providerId, {
        running: false,
        lastFinishedAt: Date.now(),
        lastDurationMs: Date.now() - startedAt,
        lastResultCount: 0,
        lastError: error?.message || 'Provider scrape failed',
        totalFailures: (failureRuntime.totalFailures || 0) + 1,
        consecutiveFailures: (failureRuntime.consecutiveFailures || 0) + 1
      });
      logger.error('provider scrape failed', {
        provider: providerId,
        hostKey: providerHostKey,
        tmdbId: normalizedTmdbId,
        mediaType: normalizedMediaType,
        error
      });
      await this.deleteCachedResult(cacheKey);
      return [];
    }
  }

  async invokeProviderWithTimeout(providerConfig, providerId, params) {
    let timeoutId;
    const abortController = new AbortController();
    const timeoutSeconds = PROVIDER_TIMEOUT_OVERRIDES_SECONDS[providerId] || config.PROVIDER_TIMEOUT_SECONDS;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        const timeoutError = createHttpError(504, `Provider ${providerId} timed out`);
        abortController.abort(timeoutError);
        reject(timeoutError);
      }, timeoutSeconds * 1000);
      timeoutId.unref?.();
    });

    const providerPromise = providerAbortSignalStorage.run(
      abortController.signal,
      () => this.invokeProvider(providerConfig, providerId, params)
    );

    return Promise.race([
      providerPromise,
      timeoutPromise
    ]).finally(() => {
      clearTimeout(timeoutId);
    });
  }

  async withProviderGlobalSlot(fn, signal = null) {
    while (this.providerGlobalInflight >= config.PROVIDER_GLOBAL_MAX_INFLIGHT) {
      await waitForProviderSlot(50, signal);
    }

    if (signal?.aborted) {
      throw getAbortReason(signal);
    }

    this.providerGlobalInflight += 1;

    try {
      return await fn();
    } finally {
      this.providerGlobalInflight = Math.max(this.providerGlobalInflight - 1, 0);
    }
  }

  getProviderHostKey(providerId) {
    return String(providerId || '')
      .trim()
      .toLowerCase()
      .replace(/(?:_tv|-tv)$/u, '');
  }

  async withProviderHostSlot(hostKey, fn, signal = null) {
    const normalizedHostKey = String(hostKey || '').trim().toLowerCase() || 'default';
    const maxInflight = PROVIDER_HOST_MAX_INFLIGHT_OVERRIDES[normalizedHostKey] || config.PROVIDER_HOST_MAX_INFLIGHT;

    while ((this.providerHostInflight.get(normalizedHostKey) || 0) >= maxInflight) {
      await waitForProviderSlot(100, signal);
    }

    if (signal?.aborted) {
      throw getAbortReason(signal);
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
    const failures = current.cooldownUntil && current.cooldownUntil <= now
      ? 1
      : current.failures + 1;
    const failureThreshold = getProviderFailureThreshold(providerId);
    const nextState = {
      failures,
      cooldownUntil: failures >= failureThreshold
        ? now + getProviderCooldownMs(providerId)
        : 0
    };

    this.providerHealth.set(providerId, nextState);

    if (nextState.cooldownUntil > now) {
      logger.warn('provider entered cooldown', {
        provider: providerId,
        failures,
        failureThreshold,
        cooldownUntil: new Date(nextState.cooldownUntil).toISOString()
      });
    }
  }

  recordProviderHostFailure(hostKey) {
    const normalizedHostKey = String(hostKey || '').trim().toLowerCase() || 'default';
    const now = Date.now();
    const current = this.providerHostHealth.get(normalizedHostKey) || { failures: 0, cooldownUntil: 0 };
    const failures = current.cooldownUntil && current.cooldownUntil <= now
      ? 1
      : current.failures + 1;
    const failureThreshold = getProviderHostFailureThreshold(normalizedHostKey);
    const nextState = {
      failures,
      cooldownUntil: failures >= failureThreshold
        ? now + getProviderHostCooldownMs(normalizedHostKey)
        : 0
    };

    this.providerHostHealth.set(normalizedHostKey, nextState);

    if (nextState.cooldownUntil > now) {
      logger.warn('provider host entered cooldown', {
        hostKey: normalizedHostKey,
        failures,
        failureThreshold,
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

    touchMapEntry(this.resultCache, cacheKey, entry);
    return deserializeStreams(entry.serializedStreams);
  }

  async getDiskCachedResult(cacheKey) {
    const cachePath = this.getCacheFilePath(cacheKey);

    try {
      const payload = JSON.parse(await readFile(cachePath, 'utf8'));
      const serializedStreams = typeof payload?.serializedStreams === 'string'
        ? payload.serializedStreams
        : Array.isArray(payload?.streams)
          ? serializeStreams(payload.streams)
          : '';
      const hydratedStreams = deserializeStreams(serializedStreams);

      if (!payload || payload.expiresAt <= Date.now() || hydratedStreams.length === 0 && !serializedStreams) {
        await rm(cachePath, { force: true });
        return null;
      }

      const entry = {
        serializedStreams,
        approxBytes: getSerializedApproxBytes(serializedStreams),
        expiresAt: payload.expiresAt
      };

      touchMapEntry(this.resultCache, cacheKey, entry);
      pruneMapByMaxEntries(this.resultCache, config.PROVIDER_RESULT_MEMORY_CACHE_MAX_ENTRIES);
      pruneMapByApproxBytes(this.resultCache, config.PROVIDER_RESULT_MEMORY_CACHE_MAX_MB * 1024 * 1024);
      logger.info('provider disk cache hit', {
        cacheKey: this.hashCacheKey(cacheKey),
        resultCount: hydratedStreams.length
      });
      return hydratedStreams;
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

    const serializedStreams = serializeStreams(streams);
    const entry = {
      serializedStreams,
      approxBytes: getSerializedApproxBytes(serializedStreams),
      expiresAt: Date.now() + (streams.length === 0
        ? PRIORITY_EMPTY_CACHE_PROVIDERS.has(providerId)
          ? config.PROVIDER_PRIORITY_EMPTY_CACHE_TTL_SECONDS
          : config.PROVIDER_EMPTY_CACHE_TTL_SECONDS
        : config.PROVIDER_CACHE_TTL_SECONDS) * 1000
    };

    touchMapEntry(this.resultCache, cacheKey, entry);
    pruneMapByMaxEntries(this.resultCache, config.PROVIDER_RESULT_MEMORY_CACHE_MAX_ENTRIES);
    pruneMapByApproxBytes(this.resultCache, config.PROVIDER_RESULT_MEMORY_CACHE_MAX_MB * 1024 * 1024);

    try {
      await writeFile(this.getCacheFilePath(cacheKey), JSON.stringify({
        expiresAt: entry.expiresAt,
        serializedStreams
      }));
    } catch (error) {
      logger.warn('provider disk cache write failed', {
        cacheKey: this.hashCacheKey(cacheKey),
        error
      });
    }
  }

  async deleteCachedResult(cacheKey) {
    this.resultCache.delete(cacheKey);

    try {
      await rm(this.getCacheFilePath(cacheKey), { force: true });
    } catch {}
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
      touchMapEntry(this.tmdbMetadataCache, cacheKey, cached);
      return cached.value;
    }

    if (this.tmdbMetadataInFlight.has(cacheKey)) {
      return this.tmdbMetadataInFlight.get(cacheKey);
    }

    const request = (async () => {
      let lastError = null;

      for (let attempt = 0; attempt <= TMDB_METADATA_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
          const response = await fetch(`https://api.themoviedb.org/3/${normalizedMediaType}/${normalizedTmdbId}?api_key=${config.TMDB_API_KEY}`);

          if (!response.ok) {
            throw new Error(`TMDB metadata HTTP ${response.status}`);
          }

          const metadata = await response.json();

          this.tmdbMetadataCache.set(cacheKey, {
            value: metadata,
            expiresAt: Date.now() + TMDB_METADATA_CACHE_TTL_MS
          });
          pruneMapByMaxEntries(this.tmdbMetadataCache, config.TMDB_METADATA_MEMORY_CACHE_MAX_ENTRIES);

          return metadata;
        } catch (error) {
          lastError = error;

          if (attempt < TMDB_METADATA_RETRY_DELAYS_MS.length) {
            await delay(TMDB_METADATA_RETRY_DELAYS_MS[attempt]);
          }
        }
      }

      if (cached?.value) {
        logger.warn('using stale tmdb metadata after fetch failure', {
          tmdbId: normalizedTmdbId,
          mediaType: normalizedMediaType,
          error: lastError
        });
        return cached.value;
      }

      throw lastError;
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

    if (
      mediaType === 'tv' &&
      !isAnime &&
      (originalLanguage === 'ko' || originCountries.has('KR'))
    ) {
      tags.push('kdrama');
    }

    if (
      mediaType === 'tv' &&
      !isAnime &&
      (
        ASIAN_DRAMA_LANGUAGES.has(originalLanguage) ||
        [...originCountries].some((country) => ASIAN_DRAMA_COUNTRIES.has(country))
      )
    ) {
      tags.push('asian_drama');
    }

    if (INDIAN_LANGUAGES.has(originalLanguage) || originCountries.has('IN')) {
      tags.push('indian');
    }

    if (originalLanguage === 'tr' || originCountries.has('TR')) {
      tags.push('turkish');
    }

    if (originalLanguage === 'it' || originCountries.has('IT')) {
      tags.push('italian');
    }

    if (originalLanguage === 'pt' || originCountries.has('BR') || originCountries.has('PT')) {
      tags.push('portuguese');
    }

    if (originalLanguage === 'es') {
      tags.push('spanish');
    }

    if (originalLanguage === 'ar' || [...originCountries].some((country) => ARABIC_COUNTRIES.has(country))) {
      tags.push('arabic');
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

    if (providerId === 'showbox') {
      return Promise.resolve().then(() => providerModule.getStreams(
        params.tmdbId,
        params.mediaType,
        params.season,
        params.episode,
        {
          uiToken: String(params.privateProviderSettings?.febboxUiCookie || '').trim(),
          ossGroup: String(params.privateProviderSettings?.showboxOssGroup || '').trim()
        }
      ));
    }

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
