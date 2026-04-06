import { pipeline } from 'node:stream/promises';
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
  constructor({ torrentEngine, httpProxy, cacheManager }) {
    this.torrentEngine = torrentEngine;
    this.httpProxy = httpProxy;
    this.cacheManager = cacheManager;
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
      const preparedSource = await this.prepareSource({
        type: req.body?.type,
        source: req.body?.source
      });

      const streamUrl = new URL('/stream', `${req.protocol}://${req.get('host')}`);
      streamUrl.searchParams.set('type', preparedSource.type);
      streamUrl.searchParams.set('source', preparedSource.streamSource ?? preparedSource.source);

      res.json({
        streamUrl: streamUrl.toString()
      });
    } catch (error) {
      logger.error('add-source failed', {
        error
      });
      next(error);
    }
  }

  async handleUnifiedStream(req, res, next) {
    try {
      const descriptor = await this.handleStreamRequest({
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
    const preparedSource = await this.prepareSource(input);
    const sourceType = preparedSource.type;
    const source = preparedSource.source;

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

    return this.httpProxy.getUpstreamStreamDescriptor({
      targetUrl: source,
      rangeHeader: input.rangeHeader
    });
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
      const normalizedUrl = await this.httpProxy.validateTargetUrl(rawSource);

      return {
        type: 'http',
        source: normalizedUrl,
        streamSource: normalizedUrl,
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
      cached
    };
  }

  async sendStream(res, descriptor) {
    const {
      stream,
      statusCode = 200,
      headers = {},
      cleanup = null
    } = descriptor;

    let completed = false;

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
        error
      });
      throw error;
    } finally {
      if (typeof cleanup === 'function') {
        await cleanup({ completed });
      }
    }
  }
}
