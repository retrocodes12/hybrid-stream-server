import path from 'node:path';

import { PluginManifestCache } from '../cache/pluginManifestCache.js';
import { NuvioPluginAdapter } from '../adapters/NuvioPluginAdapter.js';

export class PluginProviderRegistry {
  constructor({ cacheDir, logger = console }) {
    const pluginCache = new PluginManifestCache({
      cacheDir: path.join(cacheDir, 'plugin-adapters')
    });

    this.adapters = new Map([
      ['nuvio', new NuvioPluginAdapter({ cache: pluginCache, logger })]
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
      }
    ];
  }

  getAdapter(adapterId) {
    return this.adapters.get(adapterId);
  }
}

