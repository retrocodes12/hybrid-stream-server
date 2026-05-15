import vm from 'node:vm';
import { createRequire } from 'node:module';

import { PluginProviderAdapter } from './PluginProviderAdapter.js';
import { normalizePluginStreams } from '../normalizers/pluginStreamNormalizer.js';
import { withTimeout } from '../utils/timeout.js';

const require = createRequire(import.meta.url);

const DEFAULT_MANIFEST_URL = 'https://raw.githubusercontent.com/D3adlyRocket/All-in-One-Nuvio/refs/heads/main/manifest.json';
const DEFAULT_RAW_BASE_URL = 'https://raw.githubusercontent.com/D3adlyRocket/All-in-One-Nuvio/refs/heads/main/';
const DEFAULT_PROVIDER_ORDER = Object.freeze([
  'moviebox',
  'vidlink',
  '4khdhubnew',
  '4khdhub',
  'hdhub4u',
  'movieblast',
  'hdmovie2',
  'netmirror',
  'netmirrornew',
  'streamflix',
  'castle',
  'dooflix',
  'lordflix',
  'cinestream',
  'uhdmovies',
  'movies4u',
  'moviesdrive',
  'allmovieland',
  'dahmermovies-4k',
  'moviesmod',
  'vidsync',
  'videasy',
  'vixsrc',
  'vidsrc',
  'playimdb',
  'playimdb_v2',
  'multivid',
  'streamflix',
  'rgshows'
]);

const toNuvioMediaType = (mediaType) => {
  const normalized = String(mediaType || 'movie').trim().toLowerCase();
  if (normalized === 'series' || normalized === 'tv') return 'tv';
  return 'movie';
};

export class NuvioPluginAdapter extends PluginProviderAdapter {
  constructor({
    cache,
    logger = console,
    manifestUrl = DEFAULT_MANIFEST_URL,
    rawBaseUrl = DEFAULT_RAW_BASE_URL,
    providerOrder = DEFAULT_PROVIDER_ORDER,
    maxProvidersPerRequest = Infinity,
    providerTimeoutMs = 12_000,
    overallTimeoutMs = 24_000
  }) {
    super({ id: 'nuvio', logger });
    this.cache = cache;
    this.manifestUrl = manifestUrl;
    this.rawBaseUrl = rawBaseUrl;
    this.providerOrder = providerOrder;
    this.maxProvidersPerRequest = maxProvidersPerRequest;
    this.providerTimeoutMs = providerTimeoutMs;
    this.overallTimeoutMs = overallTimeoutMs;
    this.moduleCache = new Map();
  }

  async getManifest(signal = null) {
    return this.cache.getJson('nuvio/manifest', this.manifestUrl, {
      signal,
      ttlMs: 60 * 60 * 1000
    });
  }

  async getStreams(request) {
    return withTimeout(async (signal) => {
      const manifest = await this.getManifest(signal);
      const plugins = this.selectPlugins(manifest, request);
      const settled = await Promise.allSettled(
        plugins.map((plugin) => this.runPlugin(plugin, request, signal))
      );

      return settled.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
    }, this.overallTimeoutMs, 'Nuvio adapter timed out');
  }

  selectPlugins(manifest, request) {
    const scrapers = Array.isArray(manifest?.scrapers) ? manifest.scrapers : [];
    const mediaType = toNuvioMediaType(request.mediaType);
    const enabled = scrapers.filter((scraper) =>
      scraper?.enabled !== false
      && scraper?.filename
      && Array.isArray(scraper.supportedTypes)
      && scraper.supportedTypes.includes(mediaType)
    );
    const byId = new Map(enabled.map((scraper) => [String(scraper.id || '').toLowerCase(), scraper]));
    const ordered = [
      ...this.providerOrder.map((id) => byId.get(id)).filter(Boolean),
      ...enabled.filter((scraper) => !this.providerOrder.includes(String(scraper.id || '').toLowerCase()))
    ];

    if (!Number.isFinite(this.maxProvidersPerRequest) || this.maxProvidersPerRequest <= 0) {
      return ordered;
    }

    return ordered.slice(0, this.maxProvidersPerRequest);
  }

  async runPlugin(plugin, request, signal) {
    const pluginId = String(plugin.id || '').toLowerCase();

    try {
      const module = await this.loadPluginModule(plugin, signal);
      if (!module || typeof module.getStreams !== 'function') {
        throw new Error(`Nuvio plugin ${pluginId} missing getStreams()`);
      }

      const rawStreams = await withTimeout(
        () => Promise.resolve(module.getStreams(
          request.tmdbId,
          toNuvioMediaType(request.mediaType),
          request.season,
          request.episode
        )),
        this.providerTimeoutMs,
        `Nuvio plugin ${pluginId} timed out`
      );

      return normalizePluginStreams(rawStreams, {
        adapterId: this.id,
        pluginId,
        pluginName: plugin.name
      });
    } catch (error) {
      this.logger.info?.('nuvio plugin failed', {
        plugin: pluginId,
        error: error?.message || String(error)
      });
      return [];
    }
  }

  async loadPluginModule(plugin, signal = null) {
    const pluginId = String(plugin.id || plugin.filename || '').toLowerCase();
    const filename = String(plugin.filename || '').replace(/^\/+/u, '');
    const cacheKey = `${pluginId}:${filename}`;

    if (this.moduleCache.has(cacheKey)) {
      return this.moduleCache.get(cacheKey);
    }

    const scriptUrl = new URL(filename, this.rawBaseUrl).toString();
    const script = await this.cache.getText(`nuvio/scripts/${encodeURIComponent(filename)}.js`, scriptUrl, {
      signal,
      ttlMs: 6 * 60 * 60 * 1000
    });
    const loaded = this.evaluateCommonJs(script, scriptUrl);

    this.moduleCache.set(cacheKey, loaded);
    return loaded;
  }

  evaluateCommonJs(script, filename) {
    const module = { exports: {} };
    const sandbox = {
      module,
      exports: module.exports,
      require,
      fetch: globalThis.fetch,
      console: this.createPluginConsole(filename),
      AbortController,
      AbortSignal,
      Headers,
      Request,
      Response,
      URL,
      URLSearchParams,
      TextDecoder,
      TextEncoder,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      Buffer,
      process: {
        env: process.env
      },
      global: {}
    };
    sandbox.global = sandbox;
    sandbox.globalThis = sandbox;

    vm.runInNewContext(script, sandbox, {
      filename,
      timeout: 1_000
    });

    return module.exports;
  }

  createPluginConsole(filename) {
    const summarize = (args) => args
      .map((arg) => {
        if (typeof arg === 'string') return arg.slice(0, 240);
        try {
          return JSON.stringify(arg).slice(0, 240);
        } catch {
          return String(arg).slice(0, 240);
        }
      })
      .join(' ');

    return {
      log: () => {},
      info: () => {},
      warn: (...args) => this.logger.info?.('nuvio plugin warning', {
        pluginFile: filename,
        message: summarize(args)
      }),
      error: (...args) => this.logger.info?.('nuvio plugin error', {
        pluginFile: filename,
        message: summarize(args)
      })
    };
  }
}
