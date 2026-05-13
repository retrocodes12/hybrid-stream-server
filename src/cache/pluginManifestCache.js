import path from 'node:path';
import { promises as fs } from 'node:fs';

const DEFAULT_MANIFEST_TTL_MS = 60 * 60 * 1000;
const DEFAULT_SCRIPT_TTL_MS = 6 * 60 * 60 * 1000;

export class PluginManifestCache {
  constructor({
    cacheDir,
    fetchImpl = globalThis.fetch,
    manifestTtlMs = DEFAULT_MANIFEST_TTL_MS,
    scriptTtlMs = DEFAULT_SCRIPT_TTL_MS
  }) {
    this.cacheDir = cacheDir;
    this.fetchImpl = fetchImpl;
    this.manifestTtlMs = manifestTtlMs;
    this.scriptTtlMs = scriptTtlMs;
    this.memory = new Map();
  }

  async getJson(key, url, { ttlMs = this.manifestTtlMs, signal = null } = {}) {
    const text = await this.getText(`${key}.json`, url, { ttlMs, signal });
    return JSON.parse(text);
  }

  async getText(key, url, { ttlMs = this.scriptTtlMs, signal = null } = {}) {
    const now = Date.now();
    const memoryEntry = this.memory.get(key);

    if (memoryEntry && memoryEntry.expiresAt > now) {
      return memoryEntry.value;
    }

    const cachePath = path.join(this.cacheDir, key);

    try {
      const cached = JSON.parse(await fs.readFile(cachePath, 'utf8'));
      if (cached?.expiresAt > now && typeof cached.value === 'string') {
        this.memory.set(key, cached);
        return cached.value;
      }
    } catch {
      // cache miss
    }

    const response = await this.fetchImpl(url, {
      signal,
      headers: {
        'User-Agent': 'NebulaStreams/1.0 plugin-adapter',
        Accept: 'application/json,text/javascript,*/*'
      }
    });

    if (!response.ok) {
      throw new Error(`Plugin fetch failed ${response.status} for ${url}`);
    }

    const value = await response.text();
    const entry = {
      expiresAt: now + ttlMs,
      value
    };

    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(entry));
    this.memory.set(key, entry);
    return value;
  }
}

