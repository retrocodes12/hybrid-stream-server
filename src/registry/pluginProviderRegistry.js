import path from 'node:path';

import { PluginManifestCache } from '../cache/pluginManifestCache.js';
import { NuvioPluginAdapter } from '../adapters/NuvioPluginAdapter.js';
import { ScraplingServiceAdapter } from '../adapters/ScraplingServiceAdapter.js';

export class PluginProviderRegistry {
  constructor({ cacheDir, logger = console }) {
    this.logger = logger;
    const pluginCache = new PluginManifestCache({
      cacheDir: path.join(cacheDir, 'plugin-adapters')
    });

    this.adapters = new Map([
      ['nuvio', new NuvioPluginAdapter({ cache: pluginCache, logger })],
      ['scrapling', new ScraplingServiceAdapter({ logger })]
    ]);
  }

  getProviderConfigs() {
    return [
      {
        id: 'nuvio',
        label: 'Nuvio Plugins',
        kind: 'plugin-adapter',
        adapterId: 'nuvio',
        hostKey: 'plugin:nuvio'
      },
      {
        id: 'scrapling-hdhub4u',
        label: 'Scrapling HDHub4u',
        kind: 'plugin-adapter',
        adapterId: 'scrapling',
        hostKey: 'plugin:scrapling-hdhub4u'
      },
      {
        id: 'scrapling-4khdhub',
        label: 'Scrapling 4KHDHub',
        kind: 'plugin-adapter',
        adapterId: 'scrapling',
        hostKey: 'plugin:scrapling-4khdhub'
      }
    ];
  }

  getAdapter(adapterId) {
    return this.adapters.get(adapterId);
  }

  async initialize() {
    await Promise.all([...this.adapters.values()].map(async (adapter) => {
      if (typeof adapter.initialize !== 'function') return;

      try {
        await adapter.initialize();
      } catch (error) {
        this.logger?.warn?.('plugin adapter initialization failed', {
          adapter: adapter.id,
          error: error?.message || String(error)
        });
      }
    }));
  }
}
