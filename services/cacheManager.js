import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fsPromises, createWriteStream } from 'node:fs';

import { cacheConfig } from '../config.js';

const { mkdir, readFile, readdir, rm, stat, utimes, writeFile, rename } = fsPromises;

export class CacheManager {
  constructor() {
    this.httpCacheDir = cacheConfig.HTTP_CACHE_DIR;
    this.torrentCacheDir = cacheConfig.TORRENT_CACHE_DIR;
    this.maxCacheSizeBytes = cacheConfig.MAX_CACHE_SIZE_BYTES;
  }

  async initialize() {
    await mkdir(this.httpCacheDir, { recursive: true });
    await mkdir(this.torrentCacheDir, { recursive: true });
    await this.removePartialFiles();
    await this.pruneCache();
  }

  getHttpCacheKey(targetUrl) {
    return crypto.createHash('sha256').update(targetUrl).digest('hex');
  }

  getHttpPaths(targetUrl) {
    const cacheKey = this.getHttpCacheKey(targetUrl);
    const tempSuffix = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    return {
      cacheKey,
      dataPath: path.join(this.httpCacheDir, `${cacheKey}.bin`),
      metaPath: path.join(this.httpCacheDir, `${cacheKey}.json`),
      tempPath: path.join(this.httpCacheDir, `${cacheKey}.${tempSuffix}.part`)
    };
  }

  getTorrentPath(infoHash) {
    return path.join(this.torrentCacheDir, infoHash);
  }

  async getHttpCacheEntry(targetUrl) {
    const cacheKey = this.getHttpCacheKey(targetUrl);
    const dataPath = path.join(this.httpCacheDir, `${cacheKey}.bin`);
    const metaPath = path.join(this.httpCacheDir, `${cacheKey}.json`);

    try {
      const [metadataBuffer, fileStats] = await Promise.all([
        readFile(metaPath, 'utf8'),
        stat(dataPath)
      ]);

      return {
        cacheKey,
        dataPath,
        metaPath,
        metadata: JSON.parse(metadataBuffer),
        size: fileStats.size
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }

      throw error;
    }
  }

  async createHttpCacheWrite(targetUrl, upstreamHeaders) {
    const paths = this.getHttpPaths(targetUrl);
    const writer = createWriteStream(paths.tempPath, { flags: 'w' });

    const metadata = {
      url: targetUrl,
      cachedAt: new Date().toISOString(),
      contentType: upstreamHeaders['content-type'] ?? 'application/octet-stream',
      contentLength: upstreamHeaders['content-length'] ? Number.parseInt(upstreamHeaders['content-length'], 10) : null,
      etag: upstreamHeaders.etag ?? null,
      lastModified: upstreamHeaders['last-modified'] ?? null
    };

    return {
      writer,
      async commit() {
        await rm(paths.dataPath, { force: true });
        await rm(paths.metaPath, { force: true });
        await rename(paths.tempPath, paths.dataPath);
        await writeFile(paths.metaPath, JSON.stringify(metadata, null, 2));
      },
      async abort() {
        writer.destroy();
        await rm(paths.tempPath, { force: true });
      }
    };
  }

  async touchPath(targetPath) {
    const now = new Date();

    try {
      await utimes(targetPath, now, now);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async removePartialFiles() {
    const entries = await readdir(this.httpCacheDir, { withFileTypes: true });

    await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.part'))
      .map((entry) => rm(path.join(this.httpCacheDir, entry.name), { force: true })));
  }

  async pruneCache(excludedPaths = []) {
    const entries = await this.collectEntries();
    const excluded = excludedPaths.map((entryPath) => path.resolve(entryPath));
    let totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);

    if (totalSize <= this.maxCacheSizeBytes) {
      return;
    }

    const removableEntries = entries
      .filter((entry) => !excluded.some((excludedPath) => entry.path === excludedPath || entry.path.startsWith(`${excludedPath}${path.sep}`)))
      .sort((left, right) => left.lastAccessed - right.lastAccessed);

    for (const entry of removableEntries) {
      if (totalSize <= this.maxCacheSizeBytes) {
        break;
      }

      await rm(entry.path, { recursive: true, force: true });

      if (entry.metaPath) {
        await rm(entry.metaPath, { force: true });
      }

      totalSize -= entry.size;
    }
  }

  async getCacheStats(activeTorrentPaths = []) {
    const entries = await this.collectEntries();

    return {
      cacheDir: path.dirname(this.httpCacheDir),
      maxCacheSizeBytes: this.maxCacheSizeBytes,
      currentCacheSizeBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
      httpEntries: entries.filter((entry) => entry.type === 'http').length,
      torrentEntries: entries.filter((entry) => entry.type === 'torrent').length,
      activeTorrentEntries: activeTorrentPaths.length
    };
  }

  async collectEntries() {
    const [httpEntries, torrentEntries] = await Promise.all([
      this.collectHttpEntries(),
      this.collectTorrentEntries()
    ]);

    return [...httpEntries, ...torrentEntries];
  }

  async collectHttpEntries() {
    const entries = await readdir(this.httpCacheDir, { withFileTypes: true });
    const metadataFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
    const output = [];

    for (const entry of metadataFiles) {
      const metaPath = path.join(this.httpCacheDir, entry.name);
      const dataPath = path.join(this.httpCacheDir, entry.name.replace(/\.json$/u, '.bin'));

      try {
        const [fileStats] = await Promise.all([stat(dataPath), readFile(metaPath, 'utf8')]);

        output.push({
          type: 'http',
          path: dataPath,
          metaPath,
          size: fileStats.size,
          lastAccessed: fileStats.mtimeMs
        });
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
    }

    return output;
  }

  async collectTorrentEntries() {
    const entries = await readdir(this.torrentCacheDir, { withFileTypes: true });
    const output = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const entryPath = path.join(this.torrentCacheDir, entry.name);
      const [entryStats, size] = await Promise.all([
        stat(entryPath),
        this.getDirectorySize(entryPath)
      ]);

      output.push({
        type: 'torrent',
        path: entryPath,
        metaPath: null,
        size,
        lastAccessed: entryStats.mtimeMs
      });
    }

    return output;
  }

  async getDirectorySize(directoryPath) {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    let total = 0;

    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);

      if (entry.isDirectory()) {
        total += await this.getDirectorySize(entryPath);
        continue;
      }

      const fileStats = await stat(entryPath);
      total += fileStats.size;
    }

    return total;
  }
}
