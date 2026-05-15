import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { config } from '../../config.js';
import { PluginProviderAdapter } from './PluginProviderAdapter.js';
import { normalizePluginStreams } from '../normalizers/pluginStreamNormalizer.js';
import { withTimeout } from '../utils/timeout.js';

const DEFAULT_SERVICE_URL = 'http://127.0.0.1:8787';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ScraplingServiceAdapter extends PluginProviderAdapter {
  constructor({
    logger = console,
    serviceUrl = config.SCRAPLING_SERVICE_URL || DEFAULT_SERVICE_URL,
    timeoutMs = config.SCRAPLING_SERVICE_TIMEOUT_MS || 14_000,
    autoStart = config.SCRAPLING_SERVICE_AUTOSTART !== false
  } = {}) {
    super({ id: 'scrapling', logger });
    this.serviceUrl = String(serviceUrl || DEFAULT_SERVICE_URL).replace(/\/+$/u, '');
    this.timeoutMs = timeoutMs;
    this.autoStart = autoStart;
    this.child = null;
    this.startPromise = null;
  }

  async getManifest() {
    return {
      providers: ['scrapling-hdhub4u']
    };
  }

  async initialize() {
    if (!this.autoStart) return;
    await this.ensureService();
  }

  async getStreams(request) {
    const providerId = request.providerId || 'scrapling-hdhub4u';

    return withTimeout(async (signal) => {
      await this.ensureService(signal);
      const response = await fetch(`${this.serviceUrl}/scrape`, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          provider: providerId,
          tmdbId: request.tmdbId,
          mediaType: request.mediaType,
          season: request.season,
          episode: request.episode
        })
      });

      if (!response.ok) {
        throw new Error(`Scrapling service HTTP ${response.status}`);
      }

      const payload = await response.json();
      if (payload?.error) {
        this.logger.info?.('scrapling service returned error', {
          provider: providerId,
          error: payload.error
        });
      }

      return normalizePluginStreams(payload?.streams || [], {
        adapterId: providerId,
        pluginId: providerId,
        pluginName: providerId === 'scrapling-hdhub4u' ? 'Scrapling HDHub4u' : providerId
      });
    }, this.timeoutMs, 'Scrapling adapter timed out');
  }

  async ensureService(signal = null) {
    if (await this.isHealthy(signal)) {
      return;
    }

    if (!this.autoStart) {
      throw new Error('Scrapling service unavailable');
    }

    await this.startService(signal);
  }

  async isHealthy(signal = null) {
    try {
      const response = await fetch(`${this.serviceUrl}/health`, { signal });
      return response.ok;
    } catch {
      return false;
    }
  }

  async startService(signal = null) {
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.spawnAndWait(signal).finally(() => {
      this.startPromise = null;
    });

    return this.startPromise;
  }

  async spawnAndWait(signal = null) {
    if (!this.child || this.child.exitCode !== null) {
      const scriptPath = path.resolve(process.cwd(), 'services/scrapling_service/server.py');
      const venvPython = path.resolve(process.cwd(), 'services/scrapling_service/.venv/bin/python');
      const pythonBin = String(process.env.SCRAPLING_PYTHON_BIN || (existsSync(venvPython) ? venvPython : 'python3')).trim() || 'python3';
      this.child = spawn(pythonBin, [scriptPath], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          SCRAPLING_SERVICE_PORT: new URL(this.serviceUrl).port || '8787',
          TMDB_API_KEY: config.TMDB_API_KEY
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      this.child.stdout?.on('data', (chunk) => {
        this.logger.info?.('scrapling service stdout', { message: String(chunk).trim() });
      });
      this.child.stderr?.on('data', (chunk) => {
        this.logger.warn?.('scrapling service stderr', { message: String(chunk).trim() });
      });
      this.child.on('exit', (code, childSignal) => {
        this.logger.warn?.('scrapling service exited', { code, signal: childSignal });
      });
      this.child.unref?.();
    }

    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw signal.reason || new Error('Scrapling service start aborted');
      }
      if (await this.isHealthy(signal)) {
        return;
      }
      await wait(200);
    }

    throw new Error('Scrapling service did not become healthy');
  }
}
