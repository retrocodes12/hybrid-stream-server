import express from 'express';

import { config } from './config.js';
import { CacheManager } from './services/cacheManager.js';
import { HttpProxyService } from './services/httpProxy.js';
import { ImdbResolverService } from './services/imdbResolver.js';
import { ProviderService } from './services/providerService.js';
import { SourceRegistry } from './services/sourceRegistry.js';
import { StreamManager, HttpError } from './services/streamManager.js';
import { TorrentEngineService } from './services/torrentEngine.js';
import { logger } from './utils/logger.js';

const escapeHtml = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

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

const renderConfigurePage = ({ baseUrl, providers }) => {
  const providerCards = providers.map((provider) => `
    <label class="provider-card">
      <input type="checkbox" value="${escapeHtml(provider.id)}" checked>
      <span class="provider-label">${escapeHtml(provider.label)}</span>
      <span class="provider-id">${escapeHtml(provider.id)}</span>
    </label>
  `).join('');
  const qualityRows = DEFAULT_QUALITY_PRIORITY.map((quality) => `
    <div class="quality-row" data-quality="${escapeHtml(quality)}">
      <div>
        <div class="quality-label">${escapeHtml(quality.toUpperCase())}</div>
        <div class="quality-help">Higher rows are preferred first.</div>
      </div>
      <div class="quality-actions">
        <button type="button" class="move-up">Up</button>
        <button type="button" class="move-down">Down</button>
      </div>
    </div>
  `).join('');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Hybrid Stream Server Configure</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #10131a;
        --panel: #171b24;
        --panel-2: #1d2330;
        --text: #f3f5f8;
        --muted: #9aa5b4;
        --accent: #76e0a8;
        --accent-2: #3aa0ff;
        --border: rgba(255,255,255,0.08);
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        background:
          radial-gradient(circle at top left, rgba(58,160,255,0.18), transparent 28%),
          radial-gradient(circle at top right, rgba(118,224,168,0.14), transparent 24%),
          var(--bg);
        color: var(--text);
        font: 15px/1.45 system-ui, sans-serif;
      }

      main {
        max-width: 1100px;
        margin: 0 auto;
        padding: 32px 20px 40px;
      }

      .hero {
        margin-bottom: 24px;
        padding: 24px;
        background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02));
        border: 1px solid var(--border);
        border-radius: 20px;
      }

      h1 {
        margin: 0 0 8px;
        font-size: 30px;
      }

      p {
        margin: 0;
        color: var(--muted);
      }

      .toolbar {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        align-items: center;
        margin: 18px 0 0;
      }

      button, .install-link {
        appearance: none;
        border: 0;
        border-radius: 999px;
        padding: 12px 16px;
        font: inherit;
        text-decoration: none;
        cursor: pointer;
      }

      button {
        background: var(--panel-2);
        color: var(--text);
      }

      .install-link {
        background: linear-gradient(135deg, var(--accent), var(--accent-2));
        color: #0b1118;
        font-weight: 700;
      }

      .meta {
        margin-top: 16px;
        padding: 14px 16px;
        border-radius: 14px;
        background: rgba(255,255,255,0.03);
        border: 1px solid var(--border);
      }

      .meta strong {
        display: block;
        margin-bottom: 6px;
      }

      code {
        word-break: break-all;
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
        gap: 14px;
        margin-top: 22px;
      }

      .stack {
        display: grid;
        gap: 14px;
        margin-top: 22px;
      }

      .modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(6, 10, 16, 0.7);
        display: none;
        align-items: center;
        justify-content: center;
        padding: 20px;
      }

      .modal-backdrop.open {
        display: flex;
      }

      .modal {
        width: min(520px, 100%);
        padding: 22px;
        border-radius: 20px;
        border: 1px solid var(--border);
        background: linear-gradient(180deg, rgba(29,35,48,0.98), rgba(23,27,36,0.98));
        box-shadow: 0 24px 70px rgba(0,0,0,0.45);
      }

      .modal h3 {
        margin: 0 0 8px;
        font-size: 22px;
      }

      .modal p {
        margin: 0 0 16px;
      }

      .modal-actions {
        display: grid;
        gap: 12px;
      }

      .modal-actions button {
        width: 100%;
        text-align: left;
        padding: 14px 16px;
        border-radius: 14px;
      }

      .modal-actions .primary-action {
        background: linear-gradient(135deg, var(--accent), var(--accent-2));
        color: #0b1118;
        font-weight: 700;
      }

      .modal-actions .secondary-action {
        background: var(--panel-2);
        color: var(--text);
      }

      .modal-actions .ghost-action {
        background: transparent;
        border: 1px dashed rgba(255,255,255,0.18);
        color: var(--text);
      }

      .modal-close {
        margin-top: 14px;
        background: transparent;
        color: var(--muted);
        padding: 10px 0 0;
      }

      .flash {
        margin-top: 10px;
        color: var(--accent);
        font-size: 14px;
      }

      .provider-card {
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-height: 94px;
        padding: 16px;
        border-radius: 16px;
        border: 1px solid var(--border);
        background: var(--panel);
        cursor: pointer;
        transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
      }

      .provider-card:hover {
        transform: translateY(-1px);
        border-color: rgba(118,224,168,0.38);
      }

      .provider-card input {
        margin: 0 0 8px;
        width: 18px;
        height: 18px;
      }

      .provider-label {
        font-weight: 700;
      }

      .provider-id {
        color: var(--muted);
        font-size: 12px;
      }

      .section-title {
        margin: 28px 0 12px;
        font-size: 18px;
      }

      .quality-row {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
        padding: 16px;
        border-radius: 16px;
        border: 1px solid var(--border);
        background: var(--panel);
      }

      .quality-label {
        font-weight: 700;
      }

      .quality-help {
        margin-top: 4px;
        color: var(--muted);
        font-size: 12px;
      }

      .quality-actions {
        display: flex;
        gap: 8px;
      }

      .quality-actions button {
        padding: 10px 12px;
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <h1>Select Providers</h1>
        <p>Stremio does not allow custom provider cards inside the native stream picker. This page is the supported workaround: select the providers you want and install a filtered copy of the addon.</p>
        <div class="toolbar">
          <button type="button" id="select-all">Select all</button>
          <button type="button" id="clear-all">Clear all</button>
          <button type="button" id="open-install" class="install-link">Install</button>
        </div>
        <div class="meta">
          <strong>Manifest URL</strong>
          <code id="manifest-url">${escapeHtml(baseUrl)}/manifest.json</code>
        </div>
        <div class="flash" id="flash" hidden></div>
      </section>
      <h2 class="section-title">Provider Filters</h2>
      <section class="grid" id="provider-grid">
        ${providerCards}
      </section>
      <h2 class="section-title">Quality Priority</h2>
      <section class="stack" id="quality-list">
        ${qualityRows}
      </section>
    </main>
    <div class="modal-backdrop" id="install-modal" hidden>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="install-title">
        <h3 id="install-title">Install Addon</h3>
        <p>Choose how you want to open the currently configured manifest.</p>
        <div class="modal-actions">
          <button type="button" id="install-stremio" class="primary-action">Install in Stremio</button>
          <button type="button" id="install-stremio-web" class="secondary-action">Install in Stremio Web</button>
          <button type="button" id="copy-manifest" class="ghost-action">Copy Manifest URL</button>
        </div>
        <button type="button" id="close-install" class="modal-close">Close</button>
      </div>
    </div>
    <script>
      const origin = ${JSON.stringify(baseUrl)};
      const inputs = Array.from(document.querySelectorAll('#provider-grid input'));
      const qualityList = document.getElementById('quality-list');
      const manifestUrl = document.getElementById('manifest-url');
      const flash = document.getElementById('flash');
      const installModal = document.getElementById('install-modal');
      const defaultQualityPriority = ${JSON.stringify(DEFAULT_QUALITY_PRIORITY)};

      const getQualityPriority = () =>
        Array.from(document.querySelectorAll('#quality-list .quality-row'))
          .map((row) => row.dataset.quality)
          .filter(Boolean);

      const update = () => {
        const selected = inputs.filter((input) => input.checked).map((input) => input.value);
        const providerSegment = selected.length === 0 || selected.length === inputs.length
          ? 'all'
          : encodeURIComponent(selected.join(','));
        const qualitySegment = encodeURIComponent(getQualityPriority().join(',') || defaultQualityPriority.join(','));
        const url = origin + '/configured/' + providerSegment + '/' + qualitySegment + '/manifest.json';

        manifestUrl.textContent = url;
      };

      const showFlash = (text, isError = false) => {
        flash.textContent = text;
        flash.style.color = isError ? '#f87171' : '#76e0a8';
        flash.hidden = false;
        clearTimeout(flash._timer);
        flash._timer = setTimeout(() => { flash.hidden = true; }, 2200);
      };

      const getManifestUrl = () => manifestUrl.textContent.trim();

      const openInstallModal = () => {
        installModal.hidden = false;
        installModal.classList.add('open');
      };

      const closeInstallModal = () => {
        installModal.hidden = true;
        installModal.classList.remove('open');
      };

      document.getElementById('select-all').addEventListener('click', () => {
        inputs.forEach((input) => { input.checked = true; });
        update();
      });

      document.getElementById('clear-all').addEventListener('click', () => {
        inputs.forEach((input) => { input.checked = false; });
        update();
      });

      document.getElementById('open-install').addEventListener('click', openInstallModal);
      document.getElementById('close-install').addEventListener('click', closeInstallModal);

      installModal.addEventListener('click', (event) => {
        if (event.target === installModal) {
          closeInstallModal();
        }
      });

      document.getElementById('install-stremio').addEventListener('click', () => {
        const url = 'stremio://addon-install?addon=' + encodeURIComponent(getManifestUrl());
        window.location.href = url;
      });

      document.getElementById('install-stremio-web').addEventListener('click', () => {
        const url = 'https://web.stremio.com/#/addons/subscribe?addon=' + encodeURIComponent(getManifestUrl());
        window.open(url, '_blank', 'noopener');
      });

      document.getElementById('copy-manifest').addEventListener('click', async () => {
        const manifest = getManifestUrl();

        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(manifest);
          } else {
            const textarea = document.createElement('textarea');
            textarea.value = manifest;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
          }

          closeInstallModal();
          showFlash('Manifest URL copied.');
        } catch (error) {
          console.error('Copy failed', error);
          showFlash('Copy failed. Please copy manually.', true);
        }
      });

      qualityList.addEventListener('click', (event) => {
        const button = event.target.closest('button');

        if (!button) {
          return;
        }

        const row = button.closest('.quality-row');

        if (!row) {
          return;
        }

        if (button.classList.contains('move-up') && row.previousElementSibling) {
          qualityList.insertBefore(row, row.previousElementSibling);
          update();
        }

        if (button.classList.contains('move-down') && row.nextElementSibling) {
          qualityList.insertBefore(row.nextElementSibling, row);
          update();
        }
      });

      inputs.forEach((input) => input.addEventListener('change', update));
      update();
    </script>
  </body>
</html>`;
};

const bootstrap = async () => {
  const app = express();
  const cacheManager = new CacheManager();

  await cacheManager.initialize();

  const sourceRegistry = new SourceRegistry();
  const imdbResolver = new ImdbResolverService();
  const providerService = new ProviderService();
  await providerService.initialize();
  const torrentEngine = new TorrentEngineService({ cacheManager });
  const httpProxy = new HttpProxyService({ cacheManager, torrentEngine });
  const streamManager = new StreamManager({
    torrentEngine,
    httpProxy,
    cacheManager,
    sourceRegistry,
    providerService,
    imdbResolver
  });

  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '32kb' }));
  app.use('/assets', express.static('assets'));

  app.get('/health', async (_req, res, next) => {
    try {
      const cacheStats = await cacheManager.getCacheStats(torrentEngine.getActiveCachePaths());

      res.json({
        status: 'ok',
        uptimeSeconds: Math.round(process.uptime()),
        activeTorrentEngines: torrentEngine.getActiveCachePaths().length,
        activeStreams: streamManager.activeStreams,
        maxActiveStreams: config.MAX_ACTIVE_STREAMS,
        cache: cacheStats
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/configure', (req, res) => {
    res
      .status(200)
      .type('html')
      .send(renderConfigurePage({
        baseUrl: `${req.protocol}://${req.get('host')}`,
        providers: providerService.listProviders()
      }));
  });

  app.get('/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/stremio/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/configured/:providerConfig/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/configured/:providerConfig/stremio/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/stremio/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/stremio/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/configured/:providerConfig/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/configured/:providerConfig/stremio/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/stremio/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/providers', (_req, res) => {
    res.json({
      providers: providerService.listProviders()
    });
  });
  app.get('/providers/aggregate/streams', streamManager.handleAggregateProviderStreams.bind(streamManager));
  app.get('/providers/:provider/streams', streamManager.handleProviderStreams.bind(streamManager));
  app.get('/cache/stats', streamManager.handleCacheStats.bind(streamManager));
  app.post('/add-source', streamManager.handleAddSource.bind(streamManager));
  app.get('/stream', streamManager.handleUnifiedStream.bind(streamManager));
  app.get('/http-stream', streamManager.handleHttpStream.bind(streamManager));
  app.get('/stream/http', streamManager.handleHttpStream.bind(streamManager));
  app.get('/stream/torrent/:infoHash/:filename', streamManager.handleTorrentFileStream.bind(streamManager));
  app.get('/stream/torrent', streamManager.handleTorrentStream.bind(streamManager));

  app.use((_req, _res, next) => {
    next(new HttpError(404, 'Route not found'));
  });

  app.use((error, _req, res, _next) => {
    if (res.headersSent) {
      res.end();
      return;
    }

    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    const message = error instanceof HttpError ? error.message : 'Internal server error';

    if (statusCode >= 500) {
      logger.error('request failed', {
        error
      });
    }

    res.status(statusCode).json({
      error: message,
      ...(error instanceof HttpError && error.details ? { details: error.details } : {})
    });
  });

  const server = app.listen(config.PORT, () => {
    logger.info('server started', {
      port: config.PORT,
      maxActiveTorrents: config.MAX_ACTIVE_TORRENTS,
      torrentConnections: config.TORRENT_CONNECTIONS
    });
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info('server shutting down', { signal });

    const forceExitTimer = setTimeout(() => {
      process.exit(1);
    }, 10_000);

    forceExitTimer.unref();

    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }

    await torrentEngine.close();
    sourceRegistry.close();
    clearTimeout(forceExitTimer);
    process.exit(0);
  };

  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((error) => {
      logger.error('shutdown failed', { error });
      process.exit(1);
    });
  });

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((error) => {
      logger.error('shutdown failed', { error });
      process.exit(1);
    });
  });

  process.on('unhandledRejection', (error) => {
    logger.error('unhandled rejection', { error });
  });

  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception', { error });
  });
};

bootstrap().catch((error) => {
  logger.error('server bootstrap failed', { error });
  process.exit(1);
});
