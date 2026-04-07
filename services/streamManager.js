import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { enhanceMagnet, extractInfoHash } from '../utils/magnet.js';
import { logger } from '../utils/logger.js';

const detectSourceType = (source) => {
  const normalized = String(source || '').trim();

  if (!normalized) {
    return null;
  }

  if (normalized.startsWith('magnet:?')) {
    return 'magnet';
  }

  try {
    const parsedUrl = new URL(normalized);

    if (parsedUrl.protocol === 'magnet:') {
      return 'magnet';
    }

    if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
      return 'http';
    }
  } catch {
    return null;
  }

  return null;
};

const normalizeRequestedType = (type) => {
  if (typeof type !== 'string' || !type.trim()) {
    return null;
  }

  const normalized = type.trim().toLowerCase();

  if (normalized === 'http' || normalized === 'torrent') {
    return normalized;
  }

  return null;
};

const toStremioCompatibilityScore = (stream) => {
  const url = String(stream.url || '').toLowerCase();
  const title = `${String(stream.name || '')} ${String(stream.title || '')}`.toLowerCase();
  let score = 0;

  if (stream.magnet || stream.torrent) {
    return 20 + score;
  }

  if (url.includes('.mp4')) {
    score += 120;
  } else if (url.includes('.m3u8')) {
    score += 100;
  } else if (url.includes('.webm')) {
    score += 70;
  } else if (url.includes('.mkv')) {
    score += 40;
  } else {
    score += 50;
  }

  const qualityMatch = String(stream.quality || '').match(/(\d{3,4})/);

  if (qualityMatch?.[1]) {
    const quality = Number.parseInt(qualityMatch[1], 10);
    score += Math.min(quality, 1080);
  }

  if (/\b(hevc|x265|10bit|hdr|dolby vision|dovi|remux|untouch)\b/u.test(title)) {
    score -= 400;
  }

  if (/\b(x264|h264|aac)\b/u.test(title)) {
    score += 80;
  }

  if (title.includes('auto')) {
    score -= 40;
  }

  return score;
};

const getStreamFormatBadge = (stream) => {
  if (stream.magnet || stream.torrent) {
    return '[TORRENT]';
  }

  const url = String(stream.url || '').toLowerCase();
  const text = `${String(stream.name || '')} ${String(stream.title || '')}`.toLowerCase();
  const parts = [];

  if (url.includes('.mp4')) {
    parts.push('MP4');
  } else if (url.includes('.m3u8')) {
    parts.push('HLS');
  } else if (url.includes('.mkv')) {
    parts.push('MKV');
  } else if (url.includes('.webm')) {
    parts.push('WEBM');
  } else {
    parts.push('HTTP');
  }

  if (/\b(hevc|x265)\b/u.test(text)) {
    parts.push('HEVC');
  } else if (/\b(h264|x264)\b/u.test(text)) {
    parts.push('H264');
  }

  if (/\b10bit\b/u.test(text)) {
    parts.push('10BIT');
  }

  if (/\b(hdr|dolby vision|dovi)\b/u.test(text)) {
    parts.push('HDR');
  }

  return `[${parts.join('/')}]`;
};

const toTitleCaseLabel = (providerId) =>
  String(providerId || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());

const DEFAULT_QUALITY_PRIORITY = Object.freeze([
  '2160p',
  '1440p',
  '1080p',
  '720p',
  '480p',
  '360p',
  'auto',
  'unknown'
]);

const normalizeQualityKey = (quality) => {
  const normalized = String(quality || '').trim().toLowerCase();

  if (!normalized) {
    return 'unknown';
  }

  if (normalized.includes('2160') || normalized === '4k') {
    return '2160p';
  }

  if (normalized.includes('1440')) {
    return '1440p';
  }

  if (normalized.includes('1080')) {
    return '1080p';
  }

  if (normalized.includes('720')) {
    return '720p';
  }

  if (normalized.includes('480') || normalized.includes('sd') || normalized.includes('low hd')) {
    return '480p';
  }

  if (normalized.includes('360')) {
    return '360p';
  }

  if (normalized.includes('auto') || normalized.includes('adaptive') || normalized.includes('mid hd')) {
    return 'auto';
  }

  return 'unknown';
};

const getQualityPriorityScore = (stream, qualityPriority) => {
  const normalizedQuality = normalizeQualityKey(stream.quality);
  const index = qualityPriority.indexOf(normalizedQuality);

  if (index === -1) {
    return 0;
  }

  return (qualityPriority.length - index) * 10000;
};

export class HttpError extends Error {
  constructor(statusCode, message, details = undefined) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

export const createHttpError = (statusCode, message, details) =>
  new HttpError(statusCode, message, details);

export const parseRangeHeader = (rangeHeader, totalSize) => {
  if (!rangeHeader) {
    return {
      start: 0,
      end: totalSize - 1,
      contentLength: totalSize,
      statusCode: 200,
      contentRange: null
    };
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());

  if (!match) {
    throw createHttpError(416, 'Only single byte ranges are supported');
  }

  const [, rawStart, rawEnd] = match;

  if (rawStart === '' && rawEnd === '') {
    throw createHttpError(416, 'Invalid range header');
  }

  let start = rawStart === '' ? null : Number.parseInt(rawStart, 10);
  let end = rawEnd === '' ? null : Number.parseInt(rawEnd, 10);

  if ((start !== null && Number.isNaN(start)) || (end !== null && Number.isNaN(end))) {
    throw createHttpError(416, 'Invalid range header');
  }

  if (start === null) {
    const suffixLength = end;

    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      throw createHttpError(416, 'Invalid suffix range');
    }

    start = Math.max(totalSize - suffixLength, 0);
    end = totalSize - 1;
  } else {
    end = end ?? totalSize - 1;
  }

  if (start < 0 || end < 0 || start > end || start >= totalSize) {
    throw createHttpError(416, 'Requested range is not satisfiable');
  }

  end = Math.min(end, totalSize - 1);

  return {
    start,
    end,
    contentLength: end - start + 1,
    statusCode: 206,
    contentRange: `bytes ${start}-${end}/${totalSize}`
  };
};

export class StreamManager {
  constructor({ torrentEngine, httpProxy, cacheManager, sourceRegistry, providerService, imdbResolver }) {
    this.torrentEngine = torrentEngine;
    this.httpProxy = httpProxy;
    this.cacheManager = cacheManager;
    this.sourceRegistry = sourceRegistry;
    this.providerService = providerService;
    this.imdbResolver = imdbResolver;
    this.activeStreams = 0;
  }

  getRequestedProviders(req) {
    const rawConfig = typeof req.params?.providerConfig === 'string'
      ? req.params.providerConfig
      : typeof req.query?.providers === 'string'
        ? req.query.providers
        : '';
    const decoded = rawConfig ? decodeURIComponent(rawConfig) : '';

    if (!decoded || decoded === 'all') {
      return [];
    }

    const requestedProviders = decoded
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    return this.providerService.normalizeProviders(requestedProviders);
  }

  getRequestedQualityPriority(req) {
    const rawConfig = typeof req.params?.qualityConfig === 'string'
      ? req.params.qualityConfig
      : typeof req.query?.qualities === 'string'
        ? req.query.qualities
        : '';
    const decoded = rawConfig ? decodeURIComponent(rawConfig) : '';

    if (!decoded) {
      return [...DEFAULT_QUALITY_PRIORITY];
    }

    const requestedQualities = decoded
      .split(',')
      .map((value) => normalizeQualityKey(value))
      .filter(Boolean);
    const uniqueQualities = requestedQualities.filter((quality, index) =>
      requestedQualities.indexOf(quality) === index
    );

    if (uniqueQualities.length === 0) {
      return [...DEFAULT_QUALITY_PRIORITY];
    }

    for (const quality of DEFAULT_QUALITY_PRIORITY) {
      if (!uniqueQualities.includes(quality)) {
        uniqueQualities.push(quality);
      }
    }

    return uniqueQualities;
  }

  getAddonPresentation(req) {
    const providers = this.getRequestedProviders(req);
    const qualityPriority = this.getRequestedQualityPriority(req);
    const hasDefaultQualityPriority = qualityPriority.join(',') === DEFAULT_QUALITY_PRIORITY.join(',');

    if (providers.length === 0 && hasDefaultQualityPriority) {
      return {
        providers,
        qualityPriority,
        addonId: config.STREMIO_ADDON_ID,
        addonName: config.STREMIO_ADDON_NAME,
        configurable: true,
        description: 'Hybrid scraper-backed streaming addon with HTTP and torrent fallback playback'
      };
    }

    const providerHash = createHash('sha1')
      .update(`${providers.join(',')}|${qualityPriority.join(',')}`)
      .digest('hex')
      .slice(0, 10);
    const providerLabel = providers.length > 0
      ? providers.map((provider) => toTitleCaseLabel(provider)).join(', ')
      : 'All Providers';

    return {
      providers,
      qualityPriority,
      addonId: `${config.STREMIO_ADDON_ID}.${providerHash}`,
      addonName: `${config.STREMIO_ADDON_NAME} [${providerLabel}]`,
      configurable: true,
      description: `Hybrid scraper-backed streaming addon filtered to: ${providerLabel}. Quality priority: ${qualityPriority.join(' > ')}`
    };
  }

  async handleStremioManifest(req, res) {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const addonPresentation = this.getAddonPresentation(req);

    res.json({
      id: addonPresentation.addonId,
      version: '1.0.0',
      name: addonPresentation.addonName,
      description: addonPresentation.description,
      resources: [{
        name: 'stream',
        types: ['movie', 'series'],
        idPrefixes: ['tt']
      }],
      types: ['movie', 'series'],
      idPrefixes: ['tt'],
      catalogs: [],
      behaviorHints: {
        configurable: addonPresentation.configurable
      },
      logo: `${baseUrl}/favicon.ico`
    });
  }

  async handleStremioStreams(req, res, next) {
    try {
      const parsed = this.parseStremioStreamRequest(req.params.type, req.params.id);
      let tmdbId;

      try {
        tmdbId = await this.imdbResolver.resolve({
          imdbId: parsed.imdbId,
          mediaType: parsed.mediaType
        });
      } catch (error) {
        logger.warn('stremio imdb resolution failed', {
          imdbId: parsed.imdbId,
          mediaType: parsed.mediaType,
          error
        });
        res.json({ streams: [] });
        return;
      }

      if (!tmdbId) {
        res.json({ streams: [] });
        return;
      }

      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const requestedProviders = this.getRequestedProviders(req);
      const qualityPriority = this.getRequestedQualityPriority(req);
      const result = await this.providerService.getAggregateStreams({
        providers: requestedProviders.length > 0 ? requestedProviders : null,
        tmdbId,
        mediaType: parsed.mediaType === 'series' ? 'tv' : 'movie',
        season: parsed.season,
        episode: parsed.episode
      });

      if (result.streams.length === 0) {
        res.json({ streams: [] });
        return;
      }

      const normalizedStreams = await this.normalizeProviderStreams(baseUrl, result.streams);
      normalizedStreams.sort((left, right) =>
        (getQualityPriorityScore(right, qualityPriority) + toStremioCompatibilityScore(right)) -
        (getQualityPriorityScore(left, qualityPriority) + toStremioCompatibilityScore(left))
      );
      const stremioStreams = normalizedStreams.map((stream) => ({
        name: stream.provider
          ? `NebulaStreams ${String(stream.provider).toUpperCase()} ${getStreamFormatBadge(stream)}`
          : `NebulaStreams ${getStreamFormatBadge(stream)}`,
        title: [
          getStreamFormatBadge(stream),
          stream.name || null,
          stream.quality || null,
          stream.size || null
        ].filter(Boolean).join(' • '),
        url: stream.streamUrl,
        behaviorHints: {
          notWebReady: false,
          bingeGroup: parsed.mediaType === 'series'
            ? `${parsed.imdbId}:${stream.provider || 'default'}:${stream.quality || 'unknown'}`
            : undefined
        }
      }));

      res.json({
        streams: stremioStreams
      });
    } catch (error) {
      next(error);
    }
  }

  async handleTorrentStream(req, res, next) {
    try {
      const descriptor = await this.handleStreamRequest({
        source: req.query.magnet,
        fileIndex: req.query.fileIndex,
        fileName: req.query.fileName,
        rangeHeader: req.headers.range
      });

      await this.sendStream(res, descriptor);
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }

      next(error);
    }
  }

  async handleHttpStream(req, res, next) {
    try {
      const descriptor = await this.handleStreamRequest({
        source: req.query.url,
        rangeHeader: req.headers.range
      });

      await this.sendStream(res, descriptor);
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }

      next(error);
    }
  }

  async handleAddSource(req, res, next) {
    try {
      const streamUrl = await this.createRegisteredStreamUrl(`${req.protocol}://${req.get('host')}`, {
        type: req.body?.type,
        source: req.body?.source,
        headers: req.body?.headers,
        metadata: req.body?.metadata
      });

      res.json({
        streamUrl: streamUrl.toString(),
        sourceId: streamUrl.searchParams.get('sourceId')
      });
    } catch (error) {
      logger.error('add-source failed', {
        error
      });
      next(error);
    }
  }

  async handleProviderStreams(req, res, next) {
    try {
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const provider = req.params.provider;
      const streams = await this.providerService.getStreams({
        provider,
        tmdbId: req.query.tmdbId,
        mediaType: req.query.mediaType,
        season: req.query.season,
        episode: req.query.episode
      });

      if (streams.length === 0) {
        res.json({
          provider,
          count: 0,
          streams: []
        });
        return;
      }

      const normalizedStreams = await this.normalizeProviderStreams(baseUrl, streams, provider);

      res.json({
        provider,
        count: normalizedStreams.length,
        streams: normalizedStreams
      });
    } catch (error) {
      next(error);
    }
  }

  async handleAggregateProviderStreams(req, res, next) {
    try {
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const requestedProviders = typeof req.query.providers === 'string'
        ? req.query.providers.split(',').map((value) => value.trim()).filter(Boolean)
        : undefined;
      const result = await this.providerService.getAggregateStreams({
        providers: requestedProviders,
        tmdbId: req.query.tmdbId,
        mediaType: req.query.mediaType,
        season: req.query.season,
        episode: req.query.episode
      });

      if (result.streams.length === 0) {
        res.json({
          provider: null,
          count: 0,
          tried: result.tried,
          streams: []
        });
        return;
      }

      const normalizedStreams = await this.normalizeProviderStreams(baseUrl, result.streams);

      res.json({
        provider: null,
        count: normalizedStreams.length,
        tried: result.tried,
        streams: normalizedStreams
      });
    } catch (error) {
      next(error);
    }
  }

  async handleUnifiedStream(req, res, next) {
    try {
      const descriptor = await this.handleStreamRequest({
        sourceId: req.query.sourceId,
        type: req.query.type,
        source: req.query.source,
        rangeHeader: req.headers.range
      });

      await this.sendStream(res, descriptor);
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }

      next(error);
    }
  }

  async handleCacheStats(_req, res, next) {
    try {
      const stats = await this.cacheManager.getCacheStats(this.torrentEngine.getActiveCachePaths());
      res.json(stats);
    } catch (error) {
      next(error);
    }
  }

  async handleTorrentFileStream(req, res, next) {
    try {
      const descriptor = await this.torrentEngine.getStreamDescriptorByInfoHash({
        infoHash: req.params.infoHash,
        fileName: req.params.filename,
        rangeHeader: req.headers.range
      });

      await this.sendStream(res, descriptor);
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }

      next(error);
    }
  }

  async handleStreamRequest(input = {}) {
    if (typeof input.sourceId === 'string' && input.sourceId.trim()) {
      const resolved = this.sourceRegistry.get(input.sourceId.trim());

      if (!resolved) {
        throw createHttpError(404, 'Source id was not found or has expired');
      }

      return this.handleStreamRequest({
        ...input,
        type: resolved.type,
        source: resolved.source,
        headers: resolved.headers,
        metadata: resolved.metadata,
        fallback: resolved.fallback,
        sourceId: null
      });
    }

    const preparedSource = await this.prepareSource(input);
    const sourceType = preparedSource.type;
    const source = preparedSource.source;
    const fallback = preparedSource.fallback;

    if (sourceType === 'torrent') {
      return this.torrentEngine.getStreamDescriptor({
        magnet: source,
        fileIndex: input.fileIndex,
        fileName: input.fileName,
        rangeHeader: input.rangeHeader
      });
    }

    const cachedEntry = await this.cacheManager.getHttpCacheEntry(source);

    if (cachedEntry) {
      await this.cacheManager.touchPath(cachedEntry.dataPath);
      return this.httpProxy.createCachedDescriptor(cachedEntry, input.rangeHeader);
    }

    try {
      return await this.httpProxy.getUpstreamStreamDescriptor({
        targetUrl: source,
        rangeHeader: input.rangeHeader,
        requestHeaders: preparedSource.headers
      });
    } catch (error) {
      if (fallback?.type === 'torrent') {
        logger.warn('http source failed, falling back to torrent', {
          source,
          fallbackSource: fallback.source,
          error
        });

        return this.torrentEngine.getStreamDescriptor({
          magnet: fallback.source,
          fileIndex: input.fileIndex,
          fileName: input.fileName,
          rangeHeader: input.rangeHeader
        });
      }

      throw error;
    }
  }

  async prepareSource(input = {}) {
    const rawSource = input.source ?? input.url ?? input.magnet;
    const requestedType = normalizeRequestedType(input.type);
    const detectedType = detectSourceType(rawSource);
    const normalizedDetectedType = detectedType === 'magnet' ? 'torrent' : detectedType;

    if (!detectedType || !normalizedDetectedType) {
      throw createHttpError(400, 'A valid HTTP URL or magnet link is required');
    }

    if (requestedType && requestedType !== normalizedDetectedType) {
      throw createHttpError(400, `Query parameter type=${requestedType} does not match the provided source`);
    }

    if (normalizedDetectedType === 'http') {
      const normalizedUrl = input.deferValidation
        ? this.normalizeHttpSource(rawSource)
        : await this.httpProxy.validateTargetUrl(rawSource);

      return {
        type: 'http',
        source: normalizedUrl,
        streamSource: normalizedUrl,
        headers: input.headers && typeof input.headers === 'object' ? { ...input.headers } : null,
        metadata: input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : null,
        fallback: await this.prepareFallback(input.fallback),
        cached: await this.cacheManager.isCached(this.cacheManager.getHttpCacheKey(normalizedUrl))
      };
    }

    let magnet;

    try {
      magnet = enhanceMagnet(rawSource);
    } catch (error) {
      throw createHttpError(400, error.message);
    }

    const infoHash = extractInfoHash(magnet);

    if (!infoHash) {
      throw createHttpError(400, 'Invalid magnet URI');
    }

    const cached = await this.cacheManager.isCached(infoHash);

    return {
      type: 'torrent',
      source: magnet,
      streamSource: String(rawSource).trim(),
      headers: null,
      metadata: input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : null,
      fallback: null,
      cached
    };
  }

  async createRegisteredStreamUrl(baseUrl, input = {}) {
    const preparedSource = await this.prepareSource(input);
    const sourceId = this.sourceRegistry.register({
      type: preparedSource.type,
      source: preparedSource.source,
      headers: preparedSource.headers,
      metadata: preparedSource.metadata,
      fallback: preparedSource.fallback
    });
    const streamUrl = new URL('/stream', baseUrl);
    streamUrl.searchParams.set('sourceId', sourceId);
    return streamUrl;
  }

  async normalizeProviderStreams(baseUrl, streams, fallbackProvider = null) {
    const settled = await Promise.all(streams.flatMap((stream) => {
      const provider = stream.provider || fallbackProvider;
      const variants = [];
      const normalizedUrl = typeof stream.url === 'string' ? stream.url.trim() : '';
      const normalizedMagnet = typeof stream.magnet === 'string'
        ? stream.magnet.trim()
        : typeof stream.torrent === 'string'
          ? stream.torrent.trim()
          : '';

      if (normalizedUrl) {
        variants.push({
          transport: 'http',
          source: normalizedUrl,
          headers: stream.headers
        });
      }

      if (normalizedMagnet) {
        variants.push({
          transport: 'torrent',
          source: normalizedMagnet,
          headers: null
        });
      }

      return variants.map(async (variant) => {
        try {
          const streamUrl = await this.createRegisteredStreamUrl(baseUrl, {
            type: variant.transport === 'torrent' ? 'torrent' : undefined,
            source: variant.source,
            headers: variant.headers,
            deferValidation: true,
            metadata: {
              provider,
              title: stream.title || null,
              quality: stream.quality || null,
              name: stream.name || null,
              transport: variant.transport
            }
          });
          const {
            url: _url,
            magnet: _magnet,
            torrent: _torrent,
            ...rest
          } = stream;

          return {
            ...rest,
            provider,
            headers: variant.headers,
            transport: variant.transport,
            ...(variant.transport === 'http' ? { url: normalizedUrl } : { magnet: normalizedMagnet }),
            streamUrl: streamUrl.toString(),
            sourceId: streamUrl.searchParams.get('sourceId')
          };
        } catch (error) {
          logger.warn('provider stream skipped', {
            provider,
            source: variant.source,
            transport: variant.transport,
            error
          });
          return null;
        }
      });
    }));

    return settled.filter(Boolean);
  }

  parseStremioStreamRequest(type, id) {
    const normalizedType = String(type || '').trim().toLowerCase();
    const normalizedId = String(id || '').trim();

    if (normalizedType !== 'movie' && normalizedType !== 'series') {
      throw createHttpError(400, 'Unsupported Stremio stream type');
    }

    if (normalizedType === 'movie') {
      return {
        mediaType: 'movie',
        imdbId: normalizedId,
        season: null,
        episode: null
      };
    }

    const [imdbId, rawSeason, rawEpisode] = normalizedId.split(':');
    const season = Number.parseInt(rawSeason, 10);
    const episode = Number.parseInt(rawEpisode, 10);

    if (!imdbId || !Number.isInteger(season) || !Number.isInteger(episode)) {
      throw createHttpError(400, 'Series stream id must be in imdb:season:episode format');
    }

    return {
      mediaType: 'series',
      imdbId,
      season,
      episode
    };
  }

  async prepareFallback(fallbackInput) {
    if (!fallbackInput || typeof fallbackInput !== 'object') {
      return null;
    }

    const fallbackType = normalizeRequestedType(fallbackInput.type);

    if (fallbackType !== 'torrent' || typeof fallbackInput.source !== 'string') {
      return null;
    }

    let magnet;

    try {
      magnet = enhanceMagnet(fallbackInput.source);
    } catch {
      return null;
    }

    const infoHash = extractInfoHash(magnet);

    if (!infoHash) {
      return null;
    }

    return {
      type: 'torrent',
      source: magnet,
      headers: null,
      metadata: fallbackInput.metadata && typeof fallbackInput.metadata === 'object'
        ? { ...fallbackInput.metadata }
        : null
    };
  }

  normalizeHttpSource(source) {
    let parsedUrl;

    try {
      parsedUrl = new URL(String(source || '').trim());
    } catch {
      throw createHttpError(400, 'Invalid upstream URL');
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw createHttpError(400, 'Only HTTP and HTTPS upstream URLs are supported');
    }

    if (!parsedUrl.hostname) {
      throw createHttpError(400, 'Invalid upstream URL');
    }

    return parsedUrl.toString();
  }

  async sendStream(res, descriptor) {
    if (this.activeStreams >= config.MAX_ACTIVE_STREAMS) {
      logger.warn('stream rejected due to active stream limit', {
        activeStreams: this.activeStreams,
        maxActiveStreams: config.MAX_ACTIVE_STREAMS
      });
      throw createHttpError(503, 'Server is at active stream capacity');
    }

    const {
      stream,
      statusCode = 200,
      headers = {},
      cleanup = null
    } = descriptor;

    let completed = false;
    this.activeStreams += 1;

    try {
      res.status(statusCode);

      for (const [headerName, headerValue] of Object.entries(headers)) {
        if (headerValue !== undefined && headerValue !== null) {
          res.setHeader(headerName, String(headerValue));
        }
      }

      await pipeline(stream, res);
      completed = true;
    } catch (error) {
      logger.error('stream pipeline failed', {
        activeStreams: this.activeStreams,
        error
      });
      throw error;
    } finally {
      this.activeStreams = Math.max(this.activeStreams - 1, 0);

      if (typeof cleanup === 'function') {
        await cleanup({ completed });
      }
    }
  }
}
