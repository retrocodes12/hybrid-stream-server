import torrentStream from 'torrent-stream';

import { config } from '../config.js';
import { extractInfoHash, resolveRequestedFile } from '../utils/magnet.js';
import { createHttpError, parseRangeHeader } from './streamManager.js';

const MIME_TYPES = new Map([
  ['.avi', 'video/x-msvideo'],
  ['.m4v', 'video/x-m4v'],
  ['.mkv', 'video/x-matroska'],
  ['.mov', 'video/quicktime'],
  ['.mp3', 'audio/mpeg'],
  ['.mp4', 'video/mp4'],
  ['.srt', 'application/x-subrip'],
  ['.ts', 'video/mp2t'],
  ['.vtt', 'text/vtt'],
  ['.webm', 'video/webm']
]);

const getMimeType = (fileName) => {
  const normalized = String(fileName || '').toLowerCase();

  for (const [extension, mimeType] of MIME_TYPES.entries()) {
    if (normalized.endsWith(extension)) {
      return mimeType;
    }
  }

  return 'application/octet-stream';
};

const onceReady = (engine) =>
  new Promise((resolve, reject) => {
    engine.once('ready', resolve);
    engine.once('error', reject);
  });

export class TorrentEngineService {
  constructor({ cacheManager }) {
    this.cacheManager = cacheManager;
    this.engines = new Map();
    this.idleTtlMs = 5 * 60 * 1000;

    this.cleanupTimer = setInterval(() => {
      this.destroyIdleEngines().catch((error) => {
        console.error('torrent cleanup failed', error);
      });
    }, 60 * 1000);

    this.cleanupTimer.unref();
  }

  async getStreamDescriptor({ magnet, fileIndex, fileName, rangeHeader }) {
    if (typeof magnet !== 'string' || !magnet.trim()) {
      throw createHttpError(400, 'A magnet query parameter is required');
    }

    const infoHash = extractInfoHash(magnet);

    if (!infoHash) {
      throw createHttpError(400, 'Invalid magnet URI');
    }

    const record = await this.getOrCreateEngine(magnet, infoHash);
    const normalizedIndex = fileIndex === undefined ? undefined : Number.parseInt(fileIndex, 10);
    const selectedFile = resolveRequestedFile(record.engine.files, {
      fileIndex: Number.isNaN(normalizedIndex) ? undefined : normalizedIndex,
      fileName
    });

    if (!selectedFile) {
      throw createHttpError(404, 'No streamable file found in torrent');
    }

    const range = parseRangeHeader(rangeHeader, selectedFile.length);
    const streamOptions = range.statusCode === 206 ? { start: range.start, end: range.end } : undefined;
    const stream = selectedFile.createReadStream(streamOptions);

    selectedFile.select();
    record.activeStreams += 1;
    record.lastAccessedAt = Date.now();

    await this.cacheManager.touchPath(record.cachePath);

    return {
      statusCode: range.statusCode,
      stream,
      headers: {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Length': range.contentLength,
        'Content-Range': range.contentRange,
        'Content-Type': getMimeType(selectedFile.name),
        'X-Torrent-Info-Hash': infoHash,
        'X-Torrent-File-Name': selectedFile.name
      },
      cleanup: async ({ completed }) => {
        record.activeStreams = Math.max(record.activeStreams - 1, 0);
        record.lastAccessedAt = Date.now();

        if (!completed && !stream.destroyed) {
          stream.destroy();
        }
      }
    };
  }

  getActiveCachePaths() {
    return Array.from(this.engines.values(), (record) => record.cachePath);
  }

  async close() {
    clearInterval(this.cleanupTimer);
    await Promise.all(Array.from(this.engines.keys(), (infoHash) => this.destroyEngine(infoHash)));
  }

  async getOrCreateEngine(magnet, infoHash) {
    const existing = this.engines.get(infoHash);

    if (existing) {
      await existing.readyPromise;
      return existing;
    }

    await this.enforceEngineLimit();

    const cachePath = this.cacheManager.getTorrentPath(infoHash);
    const engine = torrentStream(magnet, {
      path: cachePath,
      tmp: cachePath,
      verify: true,
      dht: true,
      tracker: true,
      connections: 30,
      uploads: 2
    });

    const record = {
      engine,
      cachePath,
      activeStreams: 0,
      lastAccessedAt: Date.now(),
      readyPromise: onceReady(engine)
    };

    this.engines.set(infoHash, record);

    engine.once('error', (error) => {
      console.error(`torrent engine error for ${infoHash}`, error);
      this.engines.delete(infoHash);
    });

    try {
      await record.readyPromise;
      return record;
    } catch (error) {
      this.engines.delete(infoHash);
      try {
        engine.destroy();
      } catch {
        // Best-effort cleanup after a failed initialization.
      }
      throw createHttpError(502, 'Failed to initialize torrent engine');
    }
  }

  async enforceEngineLimit() {
    if (this.engines.size < config.MAX_ACTIVE_TORRENTS) {
      return;
    }

    await this.destroyOldestIdleEngine();

    if (this.engines.size < config.MAX_ACTIVE_TORRENTS) {
      return;
    }

    throw createHttpError(503, 'Maximum active torrent engines reached');
  }

  async destroyIdleEngines() {
    const now = Date.now();
    const candidates = Array.from(this.engines.entries())
      .filter(([, record]) => record.activeStreams === 0 && now - record.lastAccessedAt >= this.idleTtlMs)
      .sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt);

    for (const [infoHash] of candidates) {
      await this.destroyEngine(infoHash);
    }
  }

  async destroyOldestIdleEngine() {
    const candidate = Array.from(this.engines.entries())
      .filter(([, record]) => record.activeStreams === 0)
      .sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt)[0];

    if (candidate) {
      await this.destroyEngine(candidate[0]);
    }
  }

  async destroyEngine(infoHash) {
    const record = this.engines.get(infoHash);

    if (!record) {
      return;
    }

    this.engines.delete(infoHash);

    await new Promise((resolve) => {
      record.engine.destroy(() => resolve());
    });
  }
}
