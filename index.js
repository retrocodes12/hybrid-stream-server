import crypto from 'node:crypto';
import os from 'node:os';
import express from 'express';

import { config } from './config.js';
import { CacheManager } from './services/cacheManager.js';
import { HttpProxyService } from './services/httpProxy.js';
import { ImdbResolverService } from './services/imdbResolver.js';
import { ProviderService } from './services/providerService.js';
import { ReverseProxyService } from './services/reverseProxy.js';
import { SourceRegistry } from './services/sourceRegistry.js';
import { StreamManager, HttpError } from './services/streamManager.js';
import { TorrentEngineService } from './services/torrentEngine.js';
import { UserTrackerService } from './services/userTracker.js';
import { logger } from './utils/logger.js';

const escapeHtml = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const ADMIN_COOKIE_NAME = 'nebulastreams_admin';
const ADMIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CPU_SAMPLE_WINDOW_MS = 200;

const sleep = (delayMs) => new Promise((resolve) => {
  const timer = setTimeout(resolve, delayMs);
  timer.unref?.();
});

const sampleCpuTimes = () => os.cpus().reduce((totals, cpu) => {
  const cpuTotal = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);

  return {
    idle: totals.idle + cpu.times.idle,
    total: totals.total + cpuTotal
  };
}, { idle: 0, total: 0 });

const getSystemStats = async () => {
  const start = sampleCpuTimes();
  await sleep(CPU_SAMPLE_WINDOW_MS);
  const end = sampleCpuTimes();
  const totalDelta = Math.max(1, end.total - start.total);
  const idleDelta = Math.max(0, end.idle - start.idle);
  const cpuUsagePercent = Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
  const totalMemoryBytes = os.totalmem();
  const freeMemoryBytes = os.freemem();
  const usedMemoryBytes = Math.max(0, totalMemoryBytes - freeMemoryBytes);
  const processMemory = process.memoryUsage();

  return {
    cpuUsagePercent,
    cpuCount: os.cpus().length,
    loadAverage: os.loadavg(),
    totalMemoryBytes,
    freeMemoryBytes,
    usedMemoryBytes,
    memoryUsagePercent: totalMemoryBytes > 0 ? (usedMemoryBytes / totalMemoryBytes) * 100 : 0,
    processRssBytes: processMemory.rss,
    processHeapUsedBytes: processMemory.heapUsed
  };
};

const formatBytes = (bytes) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes || 0);
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
};

const formatPercent = (value) => `${Number(value || 0).toFixed(1)}%`;

const getPublicBaseUrl = (req) => config.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;

const renderConfigurePage = ({ baseUrl, providers }) => {
  const providerIds = providers.map((provider) => provider.id);
  const providerHints = providers
    .slice(0, 12)
    .map((provider) => escapeHtml(provider.id))
    .join(', ');
  const nowPaymentsWidgetUrl = escapeHtml(String(config.DONATION_NOWPAYMENTS_WIDGET_URL || '').trim());
  const hasDonationSupport = Boolean(
    config.DONATION_CRYPTO_ADDRESS ||
    config.DONATION_PRIMARY_URL ||
    config.DONATION_SECONDARY_URL ||
    config.DONATION_UPI_ID ||
    nowPaymentsWidgetUrl
  );

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>NebulaStreams Configure</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0f0f0f;
        --panel: rgba(255,255,255,0.055);
        --panel-strong: rgba(255,255,255,0.085);
        --border: rgba(255,255,255,0.11);
        --text: #f5f7ff;
        --muted: #a7afc6;
        --accent-start: #8b5cf6;
        --accent-end: #3b82f6;
        --green: #34d399;
        --danger: #ff98a8;
        --shadow: 0 28px 80px rgba(0, 0, 0, 0.42);
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        min-height: 100vh;
        padding: 24px;
        background:
          radial-gradient(circle at top left, rgba(139, 92, 246, 0.22), transparent 26%),
          radial-gradient(circle at top right, rgba(59, 130, 246, 0.18), transparent 28%),
          radial-gradient(circle at bottom center, rgba(99, 102, 241, 0.14), transparent 32%),
          var(--bg);
        color: var(--text);
        font: 15px/1.5 system-ui, sans-serif;
      }

      main {
        width: min(100%, 1080px);
        margin: 0 auto;
      }

      .shell {
        position: relative;
        overflow: hidden;
        padding: 34px 28px 24px;
        border-radius: 28px;
        border: 1px solid var(--border);
        background: linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.04));
        box-shadow: var(--shadow);
        backdrop-filter: blur(18px);
      }

      .shell::before {
        content: '';
        position: absolute;
        inset: -2px;
        background: linear-gradient(135deg, rgba(139, 92, 246, 0.18), rgba(59, 130, 246, 0.14), transparent 70%);
        pointer-events: none;
      }

      .content {
        position: relative;
        z-index: 1;
      }

      .badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-radius: 999px;
        background: rgba(255,255,255,0.06);
        color: #d9dfff;
        font-size: 12px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      h1 {
        margin: 18px 0 8px;
        font-size: clamp(32px, 7vw, 48px);
        line-height: 1.05;
      }

      .subtitle {
        margin: 0;
        color: var(--muted);
        font-size: 16px;
      }

      .support {
        margin-top: 24px;
        padding: 18px;
        border-radius: 22px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.045);
      }

      .support-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 14px;
        justify-content: center;
      }

      .support-promo {
        margin-top: 18px;
        padding: 16px 18px 18px;
        border-radius: 22px;
        border: 1px solid rgba(255,255,255,0.1);
        background: rgba(255,255,255,0.04);
        box-shadow: 0 14px 34px rgba(0,0,0,0.18);
      }

      .free-strip {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 14px;
        padding: 16px 18px;
        border-radius: 18px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.035);
      }

      .free-copy {
        min-width: 0;
      }

      .free-title {
        margin: 0;
        font-size: 15px;
        font-weight: 700;
        color: #eef2ff;
      }

      .free-title strong {
        color: #8cf0c0;
      }

      .free-copy p {
        margin: 6px 0 0;
        font-size: 13px;
        color: var(--muted);
      }

      .donate-toggle {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        min-width: 116px;
        padding: 12px 18px;
        border-radius: 14px;
        border: 0;
        text-decoration: none;
        background: linear-gradient(135deg, rgba(34,197,94,0.95), rgba(16,185,129,0.95));
        color: #f7fffb;
        box-shadow: 0 12px 24px rgba(16,185,129,0.22);
        white-space: nowrap;
        flex-shrink: 0;
      }

      .support-promo-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .support-promo-title {
        margin: 0;
        font-size: 15px;
        color: #eef2ff;
        font-weight: 700;
      }

      .support-hearts {
        color: #ff90c2;
        letter-spacing: 0.08em;
        white-space: nowrap;
      }

      .support-promo-copy {
        margin: 10px 0 0;
        color: #ced8f6;
        font-size: 14px;
      }

      .support-link {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 42px;
        padding: 0 16px;
        border-radius: 999px;
        text-decoration: none;
        color: #f8fbff;
        background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.1);
      }

      .widget-panel {
        display: none;
        margin: 14px auto 0;
        padding: 16px;
        max-width: 560px;
        border-radius: 18px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.04);
      }

      .widget-panel.open {
        display: block;
      }

      .widget-frame {
        display: block;
        width: min(100%, 420px);
        min-height: 600px;
        margin: 0 auto;
        border: 0;
        border-radius: 16px;
        background: #ffffff;
      }

      .config-grid {
        display: grid;
        grid-template-columns: minmax(0, 1.2fr) minmax(320px, 0.8fr);
        gap: 18px;
        margin-top: 24px;
      }

      .config-panel {
        padding: 20px;
        border-radius: 22px;
        border: 1px solid var(--border);
        background: var(--panel);
      }

      .panel-title {
        margin: 0;
        font-size: 16px;
      }

      .panel-subtitle {
        margin: 6px 0 0;
        color: var(--muted);
        font-size: 13px;
      }

      .field {
        margin-top: 18px;
      }

      .field-label {
        display: block;
        margin-bottom: 10px;
        color: #dfe6ff;
        font-size: 13px;
      }

      .field-input {
        width: 100%;
        padding: 14px 16px;
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 16px;
        background: rgba(255,255,255,0.04);
        color: var(--text);
        font: inherit;
        outline: none;
      }

      .field-input:focus {
        border-color: rgba(99, 102, 241, 0.6);
        box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.14);
      }

      .field-help {
        margin-top: 10px;
        color: var(--muted);
        font-size: 13px;
      }

      .toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 14px;
      }

      .mini-button {
        appearance: none;
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 999px;
        padding: 9px 14px;
        background: rgba(255,255,255,0.05);
        color: var(--text);
        cursor: pointer;
      }

      .provider-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
        gap: 10px;
        margin-top: 16px;
        max-height: 340px;
        overflow: auto;
      }

      .provider-option {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 14px;
        border-radius: 16px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.04);
        cursor: pointer;
      }

      .provider-option input {
        accent-color: #8b5cf6;
      }

      .provider-name {
        font-size: 14px;
        word-break: break-word;
      }

      .empty-state {
        margin-top: 16px;
        padding: 14px;
        border-radius: 16px;
        background: rgba(255,255,255,0.035);
        color: var(--muted);
      }

      .summary-strip {
        margin-top: 14px;
        padding: 12px 14px;
        border-radius: 16px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(12, 14, 22, 0.35);
        color: #e9eeff;
        font-size: 14px;
      }

      .quality-list {
        display: grid;
        gap: 10px;
        margin-top: 16px;
      }

      .quality-row {
        display: grid;
        grid-template-columns: auto 1fr auto;
        align-items: center;
        gap: 12px;
        padding: 12px 14px;
        border-radius: 16px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.04);
      }

      .quality-rank {
        width: 28px;
        height: 28px;
        display: grid;
        place-items: center;
        border-radius: 999px;
        background: rgba(255,255,255,0.08);
        color: #dce7ff;
        font-size: 13px;
      }

      .quality-actions {
        display: flex;
        gap: 8px;
      }

      .arrow-button {
        width: 34px;
        height: 34px;
        border-radius: 12px;
        border: 1px solid rgba(255,255,255,0.1);
        background: rgba(255,255,255,0.05);
        color: var(--text);
        cursor: pointer;
      }

      .arrow-button:disabled {
        opacity: 0.35;
        cursor: default;
      }

      .option-group {
        margin-top: 18px;
        display: grid;
        gap: 12px;
      }

      .choice-grid {
        display: grid;
        gap: 10px;
      }

      .choice-card {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 12px;
        align-items: start;
        padding: 14px;
        border-radius: 16px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.04);
      }

      .choice-card input {
        margin-top: 2px;
        accent-color: #8b5cf6;
      }

      .choice-title {
        margin: 0;
        font-size: 14px;
        color: #eef2ff;
      }

      .choice-copy {
        margin: 4px 0 0;
        color: var(--muted);
        font-size: 13px;
      }

      .manifest-box {
        margin-top: 18px;
        padding: 16px;
        border-radius: 18px;
        background: rgba(12, 14, 22, 0.45);
        border: 1px solid rgba(255,255,255,0.08);
      }

      .manifest-label {
        margin: 0 0 8px;
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      .manifest-url {
        margin: 0;
        color: #eef2ff;
        word-break: break-word;
        font-size: 14px;
      }

      .actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
        margin-top: 20px;
      }

      button {
        appearance: none;
        border: 0;
        border-radius: 999px;
        padding: 14px 18px;
        font: inherit;
        cursor: pointer;
      }

      .primary-button {
        background: linear-gradient(135deg, var(--accent-start), var(--accent-end));
        color: #f8fbff;
        box-shadow: 0 12px 30px rgba(99, 102, 241, 0.28);
      }

      .secondary-button {
        background: rgba(255,255,255,0.06);
        color: var(--text);
        border: 1px solid rgba(255,255,255,0.08);
      }

      .flash {
        min-height: 20px;
        margin-top: 14px;
        color: #e4ebff;
        font-size: 13px;
      }

      .notes {
        margin-top: 22px;
        padding-top: 18px;
        border-top: 1px solid rgba(255,255,255,0.08);
      }

      .notes-title {
        margin: 0 0 12px;
        color: #f2d469;
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      .notes-list {
        display: grid;
        gap: 10px;
      }

      .note-item {
        margin: 0;
        color: var(--muted);
        font-size: 14px;
      }

      .note-item strong {
        color: #e7ecff;
      }

      .disclaimer {
        margin-top: 16px;
        padding-top: 16px;
        border-top: 1px solid rgba(255,255,255,0.08);
      }

      .disclaimer-text {
        margin: 0;
        color: var(--muted);
        font-size: 14px;
        line-height: 1.6;
      }

      .disclaimer-text strong {
        color: var(--danger);
      }

      @media (max-width: 900px) {
        .config-grid {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 560px) {
        body {
          padding: 16px;
        }

        .shell {
          padding: 26px 20px 22px;
          border-radius: 24px;
        }

        .actions {
          grid-template-columns: 1fr;
        }

        .widget-frame {
          min-height: 680px;
        }

        .free-strip {
          flex-direction: column;
          align-items: stretch;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="shell">
        <div class="content">
          <div class="badge">Configure Add-on</div>
          <h1>NebulaStreams</h1>
          <p class="subtitle">Build a filtered install URL with provider, quality, and playback preferences.</p>

          <section class="support">
            ${hasDonationSupport ? `
              <div class="support-promo">
                <div class="free-strip">
                  <div class="free-copy">
                    <div class="free-title">This addon is <strong>completely free</strong>.</div>
                    <p>If NebulaStreams has made your setup easier, your support helps keep the servers stable for everyone using it right now.</p>
                  </div>
                  <button type="button" class="donate-toggle" id="donate-toggle">
                    <span>♥</span>
                    <span>Support</span>
                  </button>
                </div>
              </div>
            ` : `
              <div class="support-promo">
                <div class="support-promo-head">
                  <div class="support-promo-title">Feeling generous?</div>
                  <div class="support-hearts">♥ ♥ ♥</div>
                </div>
                <p class="support-promo-copy">If NebulaStreams has made your setup easier, your support helps keep the servers stable for everyone using it right now.</p>
                <div class="support-actions">
                  <a class="support-link" href="${escapeHtml(baseUrl)}/donate">Support</a>
                </div>
              </div>
            `}
            ${nowPaymentsWidgetUrl ? `
              <div class="widget-panel" id="donation-widget-panel">
                <iframe
                  class="widget-frame"
                  src="${nowPaymentsWidgetUrl}"
                  loading="lazy"
                  scrolling="no"
                  title="NOWPayments donation widget"
                >
                  Can't load widget
                </iframe>
                <div class="support-actions">
                  <a class="support-link" href="${escapeHtml(baseUrl)}/donate">Use UPI Instead</a>
                </div>
              </div>
            ` : ''}
          </section>

          <div class="config-grid">
            <section class="config-panel">
              <h2 class="panel-title">Providers</h2>
              <p class="panel-subtitle">Pick any number of providers. Leaving everything unchecked keeps the default all-provider install.</p>

              <div class="field">
                <label class="field-label" for="provider-search">Filter providers</label>
                <input
                  id="provider-search"
                  class="field-input"
                  type="text"
                  placeholder="Search providers"
                  spellcheck="false"
                  autocomplete="off"
                >
                <div class="field-help">Examples: ${providerHints || '4khdhub, cinestream, streamflix'}</div>
              </div>

              <div class="toolbar">
                <button type="button" class="mini-button" id="select-all-providers">Select all</button>
                <button type="button" class="mini-button" id="clear-providers">Clear</button>
              </div>

              <div class="summary-strip" id="provider-summary">All providers selected</div>
              <div class="provider-grid" id="provider-grid"></div>
            </section>

            <section class="config-panel">
              <h2 class="panel-title">Quality Order</h2>
              <p class="panel-subtitle">Move your preferred qualities to the top. NebulaStreams uses this order when ranking results.</p>

              <div class="toolbar">
                <button type="button" class="mini-button" id="reset-quality-order">Reset order</button>
              </div>

              <div class="quality-list" id="quality-list"></div>

              <div class="option-group">
                <h2 class="panel-title">Playback Options</h2>
                <label class="choice-card">
                  <input type="checkbox" id="web-ready-only">
                  <div>
                    <p class="choice-title">Web-ready only (Not recommended)</p>
                    <p class="choice-copy">Keep only simple MP4-style links that need no proxy headers. This is stricter and can reduce the result count a lot.</p>
                  </div>
                </label>

                <label class="choice-card">
                  <input type="checkbox" id="hide-heavy-formats">
                  <div>
                    <p class="choice-title">Hide HEVC / HDR / 10-bit</p>
                    <p class="choice-copy">Useful for lighter playback devices and players that struggle with heavier formats.</p>
                  </div>
                </label>
              </div>
            </section>
          </div>

          <div class="manifest-box">
            <div class="manifest-label">Manifest URL</div>
            <p class="manifest-url" id="manifest-url">${escapeHtml(baseUrl)}/manifest.json</p>
          </div>

          <div class="actions">
            <button type="button" class="primary-button" id="install-addon">Install Add-on</button>
            <button type="button" class="secondary-button" id="copy-url">Copy URL</button>
          </div>

          <div class="flash" id="flash" aria-live="polite"></div>

          <div class="notes">
            <div class="notes-title">Important Notes</div>
            <div class="notes-list">
              <p class="note-item"><strong>Quality order:</strong> this only affects ranking. It does not invent missing qualities from providers that have no match for a title.</p>
              <p class="note-item"><strong>Web-ready mode:</strong> this deliberately filters hard. Use it only if you want the safest direct-play subset.</p>
              <p class="note-item"><strong>Cold starts:</strong> the first request can take longer while the hosted backend wakes up and providers are queried in parallel.</p>
              <p class="note-item"><strong>Media hosting:</strong> NebulaStreams does not store the media files themselves. It discovers external links and passes them through the configured playback flow.</p>
            </div>
            <div class="disclaimer">
              <p class="disclaimer-text"><strong>Disclaimer:</strong> NebulaStreams is a stream discovery tool. It does not host, upload, or own the media itself. It should not be used to view copyrighted material without permission. The developer assumes no responsibility for how this tool is utilized.</p>
            </div>
          </div>
        </div>
      </section>
    </main>
    <script>
      const origin = ${JSON.stringify(baseUrl)};
      const providerData = ${JSON.stringify(providerIds)};
      const defaultQualityPriority = ['2160p', '1440p', '1080p', '720p', '480p', '360p', 'auto', 'unknown'];
      const selectedProviders = new Set();
      let qualityPriority = [...defaultQualityPriority];

      providerData.forEach((providerId) => selectedProviders.add(providerId));

      const providerSearch = document.getElementById('provider-search');
      const providerGrid = document.getElementById('provider-grid');
      const providerSummary = document.getElementById('provider-summary');
      const manifestUrl = document.getElementById('manifest-url');
      const flash = document.getElementById('flash');
      const copyButton = document.getElementById('copy-url');
      const installButton = document.getElementById('install-addon');
      const qualityList = document.getElementById('quality-list');
      const selectAllProvidersButton = document.getElementById('select-all-providers');
      const clearProvidersButton = document.getElementById('clear-providers');
      const resetQualityOrderButton = document.getElementById('reset-quality-order');
      const webReadyOnly = document.getElementById('web-ready-only');
      const hideHeavyFormats = document.getElementById('hide-heavy-formats');
      const donateToggle = document.getElementById('donate-toggle');
      const donationWidgetPanel = document.getElementById('donation-widget-panel');

      const escapeHtmlClient = (value) => String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');

      const showFlash = (text, isError = false) => {
        flash.textContent = text;
        flash.style.color = isError ? '#ff98a8' : '#dce7ff';
        clearTimeout(flash._timer);
        flash._timer = setTimeout(() => { flash.textContent = ''; }, 2200);
      };

      const copyText = async (value, successMessage) => {
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(value);
          } else {
            const textarea = document.createElement('textarea');
            textarea.value = value;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
          }

          showFlash(successMessage);
        } catch (error) {
          console.error('Copy failed', error);
          showFlash('Copy failed. Please copy manually.', true);
        }
      };

      const isDefaultQualityOrder = () =>
        qualityPriority.length === defaultQualityPriority.length &&
        qualityPriority.every((quality, index) => quality === defaultQualityPriority[index]);

      const getOrderedProviders = () =>
        providerData.filter((providerId) => selectedProviders.has(providerId));

      const getOptionTokens = () => {
        const tokens = [];

        if (webReadyOnly.checked) {
          tokens.push('web-ready-only');
        }

        if (hideHeavyFormats.checked) {
          tokens.push('hide-heavy-formats');
        }

        return tokens;
      };

      const buildManifestPath = () => {
        const orderedProviders = getOrderedProviders();
        const providerSegment = orderedProviders.length > 0 && orderedProviders.length < providerData.length
          ? encodeURIComponent(orderedProviders.join(','))
          : 'all';
        const qualitySegment = isDefaultQualityOrder()
          ? 'default'
          : encodeURIComponent(qualityPriority.join(','));
        const optionTokens = getOptionTokens();

        if (providerSegment === 'all' && qualitySegment === 'default' && optionTokens.length === 0) {
          return '/manifest.json';
        }

        if (optionTokens.length === 0 && qualitySegment === 'default') {
          return '/configured/' + providerSegment + '/manifest.json';
        }

        if (optionTokens.length === 0) {
          return '/configured/' + providerSegment + '/' + qualitySegment + '/manifest.json';
        }

        return '/configured/' + providerSegment + '/' + qualitySegment + '/' + encodeURIComponent(optionTokens.join(',')) + '/manifest.json';
      };

      const updateProviderSummary = () => {
        const orderedProviders = getOrderedProviders();

        if (orderedProviders.length === providerData.length) {
          providerSummary.textContent = 'All providers selected';
          return;
        }

        if (orderedProviders.length === 0) {
          providerSummary.textContent = 'No providers checked. Falling back to all providers.';
          return;
        }

        providerSummary.textContent = orderedProviders.length + ' provider' + (orderedProviders.length === 1 ? '' : 's') + ' selected: ' + orderedProviders.join(', ');
      };

      const renderProviderOptions = () => {
        const filter = providerSearch.value.trim().toLowerCase();
        const visibleProviders = providerData.filter((providerId) => providerId.includes(filter));

        if (visibleProviders.length === 0) {
          providerGrid.innerHTML = '<div class="empty-state">No providers match that filter.</div>';
          return;
        }

        providerGrid.innerHTML = visibleProviders.map((providerId) =>
          '<label class="provider-option">' +
            '<input type="checkbox" data-provider-id="' + escapeHtmlClient(providerId) + '" ' + (selectedProviders.has(providerId) ? 'checked' : '') + '>' +
            '<span class="provider-name">' + escapeHtmlClient(providerId) + '</span>' +
          '</label>'
        ).join('');
      };

      const renderQualityList = () => {
        qualityList.innerHTML = qualityPriority.map((quality, index) =>
          '<div class="quality-row">' +
            '<div class="quality-rank">' + (index + 1) + '</div>' +
            '<div>' + escapeHtmlClient(quality.toUpperCase()) + '</div>' +
            '<div class="quality-actions">' +
              '<button type="button" class="arrow-button" data-quality-index="' + index + '" data-quality-move="-1" ' + (index === 0 ? 'disabled' : '') + '>↑</button>' +
              '<button type="button" class="arrow-button" data-quality-index="' + index + '" data-quality-move="1" ' + (index === qualityPriority.length - 1 ? 'disabled' : '') + '>↓</button>' +
            '</div>' +
          '</div>'
        ).join('');
      };

      const updateManifest = () => {
        manifestUrl.textContent = origin + buildManifestPath();
        updateProviderSummary();
      };

      providerSearch.addEventListener('input', () => {
        renderProviderOptions();
      });

      providerGrid.addEventListener('change', (event) => {
        const providerId = event.target?.dataset?.providerId;

        if (!providerId) {
          return;
        }

        if (event.target.checked) {
          selectedProviders.add(providerId);
        } else {
          selectedProviders.delete(providerId);
        }

        updateManifest();
      });

      selectAllProvidersButton.addEventListener('click', () => {
        providerData.forEach((providerId) => selectedProviders.add(providerId));
        renderProviderOptions();
        updateManifest();
      });

      clearProvidersButton.addEventListener('click', () => {
        selectedProviders.clear();
        renderProviderOptions();
        updateManifest();
      });

      resetQualityOrderButton.addEventListener('click', () => {
        qualityPriority = [...defaultQualityPriority];
        renderQualityList();
        updateManifest();
      });

      qualityList.addEventListener('click', (event) => {
        const index = Number.parseInt(event.target?.dataset?.qualityIndex || '', 10);
        const move = Number.parseInt(event.target?.dataset?.qualityMove || '', 10);

        if (!Number.isInteger(index) || !Number.isInteger(move)) {
          return;
        }

        const nextIndex = index + move;

        if (nextIndex < 0 || nextIndex >= qualityPriority.length) {
          return;
        }

        const reordered = [...qualityPriority];
        const [movedQuality] = reordered.splice(index, 1);
        reordered.splice(nextIndex, 0, movedQuality);
        qualityPriority = reordered;
        renderQualityList();
        updateManifest();
      });

      webReadyOnly.addEventListener('change', updateManifest);
      hideHeavyFormats.addEventListener('change', updateManifest);

      installButton.addEventListener('click', () => {
        window.location.href = 'stremio://addon-install?addon=' + encodeURIComponent(manifestUrl.textContent.trim());
      });

      copyButton.addEventListener('click', () => {
        copyText(manifestUrl.textContent.trim(), 'Manifest URL copied.');
      });

      if (donateToggle && donationWidgetPanel) {
        donateToggle.addEventListener('click', () => {
          donationWidgetPanel.classList.toggle('open');
        });
      }

      renderProviderOptions();
      renderQualityList();
      updateManifest();
    </script>
  </body>
</html>`;
};

const renderAdminPage = ({ stats }) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>NebulaStreams Admin</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0a0f19;
        --panel: #141b2a;
        --panel-2: #1a2335;
        --text: #eef3ff;
        --muted: #98a7c7;
        --accent: #66b6ff;
        --border: rgba(255,255,255,0.08);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background:
          radial-gradient(circle at top left, rgba(102,182,255,0.18), transparent 24%),
          radial-gradient(circle at top right, rgba(123,112,255,0.18), transparent 20%),
          var(--bg);
        color: var(--text);
        font: 15px/1.5 system-ui, sans-serif;
      }
      main {
        max-width: 1180px;
        margin: 0 auto;
        padding: 32px 20px 48px;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 34px;
      }
      .header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 16px;
      }
      p {
        margin: 0;
        color: var(--muted);
      }
      .logout-form {
        margin: 0;
      }
      .logout-form button {
        appearance: none;
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 10px 14px;
        background: var(--panel);
        color: var(--text);
        cursor: pointer;
        font: inherit;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
        gap: 16px;
        margin-top: 24px;
      }
      .card {
        padding: 18px;
        border-radius: 18px;
        border: 1px solid var(--border);
        background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015));
      }
      .label {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .value {
        margin-top: 8px;
        font-size: 28px;
        font-weight: 700;
      }
      .section {
        margin-top: 28px;
        padding: 22px;
        border-radius: 22px;
        border: 1px solid var(--border);
        background: var(--panel);
      }
      .meta-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 14px;
        margin-top: 16px;
      }
      code {
        display: inline-block;
        margin-top: 6px;
        padding: 8px 10px;
        border-radius: 12px;
        background: var(--panel-2);
        color: #dff1ff;
        word-break: break-word;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="header">
        <div>
          <h1>NebulaStreams Admin</h1>
          <p>Private runtime dashboard for service health, usage, cache, provider state, and source registry.</p>
        </div>
        <form class="logout-form" method="post" action="/admin/logout">
          <button type="submit">Sign out</button>
        </form>
      </div>

      <section class="grid">
        <div class="card"><div class="label">Uptime</div><div class="value">${stats.runtime.uptimeSeconds}s</div></div>
        <div class="card"><div class="label">System CPU</div><div class="value">${formatPercent(stats.system.cpuUsagePercent)}</div></div>
        <div class="card"><div class="label">System Memory</div><div class="value">${formatPercent(stats.system.memoryUsagePercent)}</div></div>
        <div class="card"><div class="label">Process RSS</div><div class="value">${formatBytes(stats.system.processRssBytes)}</div></div>
        <div class="card"><div class="label">Active Streams</div><div class="value">${stats.runtime.activeStreams}/${stats.runtime.maxActiveStreams}</div></div>
        <div class="card"><div class="label">Active Torrents</div><div class="value">${stats.runtime.activeTorrentEngines}</div></div>
        <div class="card"><div class="label">Human Users</div><div class="value">${stats.users.totalUsers}</div></div>
        <div class="card"><div class="label">Users 24h</div><div class="value">${stats.users.activeUsers24h}</div></div>
        <div class="card"><div class="label">Stream Users</div><div class="value">${stats.users.streamUsers}</div></div>
        <div class="card"><div class="label">Human Requests</div><div class="value">${stats.users.totalTrackedRequests}</div></div>
      </section>

      <section class="section">
        <h2>System</h2>
        <div class="meta-grid">
          <div><div class="label">CPU Usage</div><code>${escapeHtml(formatPercent(stats.system.cpuUsagePercent))}</code></div>
          <div><div class="label">CPU Cores</div><code>${escapeHtml(String(stats.system.cpuCount))}</code></div>
          <div><div class="label">Load Average</div><code>${escapeHtml(stats.system.loadAverage.map((value) => value.toFixed(2)).join(' / '))}</code></div>
          <div><div class="label">Memory Used</div><code>${escapeHtml(formatBytes(stats.system.usedMemoryBytes))}</code></div>
          <div><div class="label">Memory Free</div><code>${escapeHtml(formatBytes(stats.system.freeMemoryBytes))}</code></div>
          <div><div class="label">Memory Total</div><code>${escapeHtml(formatBytes(stats.system.totalMemoryBytes))}</code></div>
          <div><div class="label">Process RSS</div><code>${escapeHtml(formatBytes(stats.system.processRssBytes))}</code></div>
          <div><div class="label">Process Heap Used</div><code>${escapeHtml(formatBytes(stats.system.processHeapUsedBytes))}</code></div>
        </div>
      </section>

      <section class="section">
        <h2>Traffic</h2>
        <div class="meta-grid">
          <div><div class="label">Raw Unique Clients</div><code>${escapeHtml(String(stats.users.rawUniqueClients))}</code></div>
          <div><div class="label">Raw Requests</div><code>${escapeHtml(String(stats.users.rawTrackedRequests))}</code></div>
          <div><div class="label">Bot Clients</div><code>${escapeHtml(String(stats.users.botClients))}</code></div>
          <div><div class="label">Bot Requests</div><code>${escapeHtml(String(stats.users.botRequests))}</code></div>
          <div><div class="label">Mixed Clients</div><code>${escapeHtml(String(stats.users.mixedClients))}</code></div>
          <div><div class="label">Manifest Requests</div><code>${escapeHtml(String(stats.users.manifestRequests))}</code></div>
          <div><div class="label">Stream Requests</div><code>${escapeHtml(String(stats.users.streamRequests))}</code></div>
        </div>
      </section>

      <section class="section">
        <h2>Cache</h2>
        <div class="meta-grid">
          <div><div class="label">Cache Dir</div><code>${escapeHtml(stats.cache.cacheDir)}</code></div>
          <div><div class="label">Current Size</div><code>${escapeHtml(String(stats.cache.currentCacheSizeBytes))}</code></div>
          <div><div class="label">Max Size</div><code>${escapeHtml(String(stats.cache.maxCacheSizeBytes))}</code></div>
          <div><div class="label">HTTP Entries</div><code>${escapeHtml(String(stats.cache.httpEntries))}</code></div>
          <div><div class="label">Provider Entries</div><code>${escapeHtml(String(stats.cache.providerEntries))}</code></div>
          <div><div class="label">Torrent Entries</div><code>${escapeHtml(String(stats.cache.torrentEntries))}</code></div>
        </div>
      </section>

      <section class="section">
        <h2>Providers</h2>
        <div class="meta-grid">
          <div><div class="label">Discovered</div><code>${escapeHtml(String(stats.providers.discoveredProviders))}</code></div>
          <div><div class="label">Memory Cache Entries</div><code>${escapeHtml(String(stats.providers.inMemoryCacheEntries))}</code></div>
          <div><div class="label">In-Flight Requests</div><code>${escapeHtml(String(stats.providers.inFlightRequests))}</code></div>
          <div><div class="label">Provider Cache Dir</div><code>${escapeHtml(stats.providers.providerCacheDir)}</code></div>
        </div>
      </section>

      <section class="section">
        <h2>Registry</h2>
        <div class="meta-grid">
          <div><div class="label">Source Entries</div><code>${escapeHtml(String(stats.sourceRegistry.entries))}</code></div>
          <div><div class="label">Fallback Entries</div><code>${escapeHtml(String(stats.sourceRegistry.activeFallbackEntries))}</code></div>
          <div><div class="label">TTL (ms)</div><code>${escapeHtml(String(stats.sourceRegistry.ttlMs))}</code></div>
        </div>
      </section>
    </main>
  </body>
</html>`;

const renderAdminLoginPage = ({ errorMessage = '' } = {}) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>NebulaStreams Admin Login</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0a0f19;
        --panel: #141b2a;
        --text: #eef3ff;
        --muted: #98a7c7;
        --accent: #66b6ff;
        --danger: #ff7b8a;
        --border: rgba(255,255,255,0.08);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at top left, rgba(102,182,255,0.18), transparent 24%),
          radial-gradient(circle at top right, rgba(123,112,255,0.18), transparent 20%),
          var(--bg);
        color: var(--text);
        font: 15px/1.5 system-ui, sans-serif;
      }
      .panel {
        width: min(420px, calc(100vw - 32px));
        padding: 28px;
        border-radius: 22px;
        border: 1px solid var(--border);
        background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015));
        box-shadow: 0 20px 60px rgba(0,0,0,0.35);
      }
      h1 {
        margin: 0 0 8px;
        font-size: 30px;
      }
      p {
        margin: 0;
        color: var(--muted);
      }
      form {
        display: grid;
        gap: 14px;
        margin-top: 22px;
      }
      label {
        display: grid;
        gap: 8px;
      }
      input {
        width: 100%;
        padding: 12px 14px;
        border-radius: 14px;
        border: 1px solid var(--border);
        background: var(--panel);
        color: var(--text);
        font: inherit;
      }
      button {
        appearance: none;
        border: 0;
        border-radius: 999px;
        padding: 12px 16px;
        background: linear-gradient(135deg, var(--accent), #7b70ff);
        color: #081018;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
      }
      .error {
        margin-top: 14px;
        color: var(--danger);
      }
    </style>
  </head>
  <body>
    <main class="panel">
      <h1>NebulaStreams Admin</h1>
      <p>Sign in to view private runtime stats and usage data.</p>
      ${errorMessage ? `<div class="error">${escapeHtml(errorMessage)}</div>` : ''}
      <form method="post" action="/admin/login">
        <label>
          <span>Username</span>
          <input name="username" type="text" autocomplete="username" required>
        </label>
        <label>
          <span>Password</span>
          <input name="password" type="password" autocomplete="current-password" required>
        </label>
        <button type="submit">Sign in</button>
      </form>
    </main>
  </body>
</html>`;

const renderDonatePage = ({ baseUrl }) => {
  const upiId = config.DONATION_UPI_ID || '';
  const upiSection = config.DONATION_UPI_ID
    ? `
      <div class="support-card">
        <div class="support-label">UPI</div>
        <div class="support-value">Pay with any supported UPI app.</div>
        <div class="copy-actions">
          <a class="copy-button" id="open-upi" href="#">Open UPI App</a>
          <button type="button" class="copy-button" id="copy-upi">Copy UPI ID</button>
        </div>
      </div>
    `
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>NebulaStreams Donate</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0f0f0f;
        --card-bg: rgba(255, 255, 255, 0.07);
        --card-border: rgba(255, 255, 255, 0.12);
        --text: #f5f7ff;
        --muted: #a7afc6;
        --accent-start: #8b5cf6;
        --accent-end: #3b82f6;
        --surface: rgba(255, 255, 255, 0.05);
        --shadow: 0 28px 80px rgba(0, 0, 0, 0.42);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background:
          radial-gradient(circle at top left, rgba(139, 92, 246, 0.22), transparent 26%),
          radial-gradient(circle at top right, rgba(59, 130, 246, 0.18), transparent 28%),
          radial-gradient(circle at bottom center, rgba(99, 102, 241, 0.14), transparent 32%),
          var(--bg);
        color: var(--text);
        font: 15px/1.5 system-ui, sans-serif;
      }
      main {
        width: min(100%, 680px);
      }
      .shell {
        position: relative;
        overflow: hidden;
        padding: 34px 28px 26px;
        border-radius: 30px;
        border: 1px solid var(--card-border);
        background: linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.04));
        box-shadow: var(--shadow);
        backdrop-filter: blur(18px);
      }
      .shell::before {
        content: '';
        position: absolute;
        inset: -2px;
        background: linear-gradient(135deg, rgba(139, 92, 246, 0.18), rgba(59, 130, 246, 0.14), transparent 70%);
        pointer-events: none;
        z-index: 0;
      }
      .content {
        position: relative;
        z-index: 1;
      }
      .logo-wrap {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 82px;
        height: 82px;
        border-radius: 24px;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.08);
        box-shadow: 0 0 0 1px rgba(255,255,255,0.02), 0 12px 38px rgba(99, 102, 241, 0.18);
      }
      .logo-wrap img {
        width: 62px;
        height: 62px;
        object-fit: cover;
        border-radius: 18px;
      }
      h1 {
        margin: 18px 0 10px;
        font-size: clamp(34px, 8vw, 52px);
        line-height: 1.04;
      }
      .subtitle {
        margin: 0;
        color: var(--muted);
        font-size: 17px;
        max-width: 560px;
      }
      .blurb {
        margin-top: 22px;
        padding: 18px;
        border-radius: 20px;
        background: rgba(12, 14, 22, 0.45);
        border: 1px solid rgba(255,255,255,0.08);
      }
      .blurb p {
        margin: 0;
        color: #dbe4ff;
      }
      .button, .copy-button {
        appearance: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 54px;
        border-radius: 999px;
        padding: 14px 18px;
        font: inherit;
        text-decoration: none;
        cursor: pointer;
        transition: transform 140ms ease, box-shadow 160ms ease, opacity 140ms ease;
      }
      .button:hover, .copy-button:hover {
        transform: translateY(-1px);
      }
      .button:active, .copy-button:active {
        transform: translateY(0);
      }
      .button-primary {
        border: 0;
        background: linear-gradient(135deg, var(--accent-start), var(--accent-end));
        color: #f8fbff;
        box-shadow: 0 12px 30px rgba(99, 102, 241, 0.28);
      }
      .button-secondary, .copy-button {
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.06);
        color: var(--text);
      }
      .support-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 14px;
        margin-top: 22px;
      }
      .support-card {
        padding: 18px;
        border-radius: 22px;
        background: rgba(255,255,255,0.045);
        border: 1px solid rgba(255,255,255,0.08);
      }
      .support-label {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .support-value {
        margin-top: 8px;
        font-size: 18px;
        color: #eef2ff;
        word-break: break-word;
      }
      .copy-button {
        margin-top: 14px;
        width: 100%;
        text-decoration: none;
      }
      .copy-actions {
        display: grid;
        gap: 10px;
      }
      .footer-note {
        margin-top: 18px;
        color: var(--muted);
        font-size: 13px;
      }
      .footer-note a {
        color: #cfd8ff;
      }
      .flash {
        min-height: 20px;
        margin-top: 12px;
        color: #dce7ff;
        font-size: 13px;
      }
      @media (max-width: 560px) {
        body {
          padding: 16px;
        }
        .shell {
          padding: 28px 20px 22px;
          border-radius: 24px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="shell">
        <div class="content">
          <div class="logo-wrap">
            <img src="${escapeHtml(baseUrl)}/assets/nebulastreams-icon.jpg" alt="NebulaStreams">
          </div>
          <h1>Support NebulaStreams</h1>
          <p class="subtitle">Help keep the self-hosted streaming backend online, maintained, and improving over time.</p>

          <div class="blurb">
            <p>If NebulaStreams is useful to you, your support helps cover hosting, testing, and new provider work. Every contribution keeps the project more reliable.</p>
          </div>
          ${upiSection ? `<div class="support-grid">${upiSection}</div>` : ''}

          <div class="flash" id="flash" aria-live="polite"></div>
          <p class="footer-note">Main site: <a href="${escapeHtml(baseUrl)}" target="_blank" rel="noopener">${escapeHtml(baseUrl)}</a></p>
        </div>
      </section>
    </main>
    <script>
      const flash = document.getElementById('flash');
      const upiId = ${JSON.stringify(upiId)};
      const copyText = async (value, successMessage) => {
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(value);
          } else {
            const textarea = document.createElement('textarea');
            textarea.value = value;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
          }

          flash.textContent = successMessage;
          clearTimeout(flash._timer);
          flash._timer = setTimeout(() => { flash.textContent = ''; }, 2200);
        } catch {
          flash.textContent = 'Copy failed. Please copy manually.';
        }
      };

      const copyUpiButton = document.getElementById('copy-upi');
      const openUpi = document.getElementById('open-upi');

      if (copyUpiButton && upiId) {
        copyUpiButton.addEventListener('click', () => {
          void copyText(upiId, 'UPI ID copied.');
        });
      }

      const copyCryptoButton = document.getElementById('copy-crypto');
      const cryptoValue = document.getElementById('crypto-value');
      const qrImage = document.getElementById('crypto-qr');

      if (copyCryptoButton && cryptoValue) {
        copyCryptoButton.addEventListener('click', () => {
          void copyText(cryptoValue.textContent.trim(), 'Wallet address copied.');
        });
      }

      if (qrImage && cryptoValue) {
        const qrPayload = encodeURIComponent('https://link.trustwallet.com/send?asset=c195_tTR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t&address=' + cryptoValue.textContent.trim());
        qrImage.src = 'https://api.qrserver.com/v1/create-qr-code/?size=280x280&margin=8&data=' + qrPayload;
      }

      if (openUpi) {
        if (upiId) {
          openUpi.href = 'upi://pay?pa=' + encodeURIComponent(upiId);
        } else {
          openUpi.style.display = 'none';
        }
      }

    </script>
  </body>
</html>`;
};

const parseBasicAuth = (headerValue) => {
  if (!headerValue || !headerValue.startsWith('Basic ')) {
    return null;
  }

  try {
    const decoded = Buffer.from(headerValue.slice(6), 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');

    if (separatorIndex === -1) {
      return null;
    }

    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1)
    };
  } catch {
    return null;
  }
};

const parseCookies = (cookieHeader) => {
  if (!cookieHeader) {
    return {};
  }

  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separatorIndex = part.indexOf('=');

      if (separatorIndex === -1) {
        return cookies;
      }

      const key = part.slice(0, separatorIndex);
      const value = part.slice(separatorIndex + 1);
      cookies[key] = decodeURIComponent(value);
      return cookies;
    }, {});
};

const createAdminSessionToken = () => {
  const payload = Buffer.from(JSON.stringify({
    username: config.ADMIN_USERNAME,
    expiresAt: Date.now() + ADMIN_SESSION_TTL_MS
  })).toString('base64url');
  const signature = crypto
    .createHmac('sha256', `${config.ADMIN_USERNAME}:${config.ADMIN_PASSWORD}`)
    .update(payload)
    .digest('base64url');

  return `${payload}.${signature}`;
};

const verifyAdminSessionToken = (token) => {
  if (!token || !token.includes('.')) {
    return false;
  }

  const [payload, signature] = token.split('.', 2);
  const expectedSignature = crypto
    .createHmac('sha256', `${config.ADMIN_USERNAME}:${config.ADMIN_PASSWORD}`)
    .update(payload)
    .digest('base64url');

  if (signature.length !== expectedSignature.length) {
    return false;
  }

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    return false;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return decoded.username === config.ADMIN_USERNAME && Number(decoded.expiresAt) > Date.now();
  } catch {
    return false;
  }
};

const setAdminSessionCookie = (req, res) => {
  const cookieParts = [
    `${ADMIN_COOKIE_NAME}=${encodeURIComponent(createAdminSessionToken())}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}`
  ];

  if (req.secure) {
    cookieParts.push('Secure');
  }

  res.setHeader('Set-Cookie', cookieParts.join('; '));
};

const clearAdminSessionCookie = (res) => {
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
};

const getClientAddress = (req) => {
  const forwarded = req.headers?.['x-forwarded-for'];

  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  return String(req.ip || req.socket?.remoteAddress || 'unknown').trim();
};

const createRateLimiter = ({ windowMs, limit, name, matcher }) => {
  const buckets = new Map();

  return (req, res, next) => {
    if (!matcher(req)) {
      next();
      return;
    }

    const now = Date.now();
    const key = `${name}:${getClientAddress(req)}`;
    const current = buckets.get(key);

    if (!current || current.resetAt <= now) {
      buckets.set(key, {
        count: 1,
        resetAt: now + windowMs
      });
      next();
      return;
    }

    current.count += 1;

    if (current.count <= limit) {
      next();
      return;
    }

    const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    res.setHeader('Retry-After', String(retryAfterSeconds));

    logger.warn('request rate limited', {
      limiter: name,
      path: req.path,
      ip: getClientAddress(req),
      retryAfterSeconds
    });

    const acceptsHtml = String(req.headers.accept || '').includes('text/html');

    if (acceptsHtml) {
      res.status(429).type('html').send('Too many requests. Please try again shortly.');
      return;
    }

    res.status(429).json({
      error: 'Too many requests',
      retryAfterSeconds
    });
  };
};

const hasValidAdminSession = (req) => {
  const cookies = parseCookies(req.headers.cookie);
  return verifyAdminSessionToken(cookies[ADMIN_COOKIE_NAME]);
};

const requireAdminAuth = (req, res, next) => {
  if (hasValidAdminSession(req)) {
    next();
    return;
  }

  const credentials = parseBasicAuth(req.headers.authorization);

  if (!credentials || credentials.username !== config.ADMIN_USERNAME || credentials.password !== config.ADMIN_PASSWORD) {
    res.redirect(302, '/admin/login');
    return;
  }

  setAdminSessionCookie(req, res);
  next();
};

const bootstrap = async () => {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  if (config.REVERSE_PROXY_TARGET) {
    const reverseProxy = new ReverseProxyService({
      targetBaseUrl: config.REVERSE_PROXY_TARGET,
      timeoutSeconds: config.REVERSE_PROXY_TIMEOUT_SECONDS
    });

    app.get('/health', (_req, res) => {
      res.json({
        status: 'ok',
        mode: 'reverse-proxy',
        target: config.REVERSE_PROXY_TARGET
      });
    });

    app.use((req, res, next) => {
      reverseProxy.handle(req, res, next).catch(next);
    });

    app.use((error, _req, res, _next) => {
      logger.error('reverse proxy request failed', { error });
      res.status(502).json({
        error: 'Reverse proxy request failed',
        details: error?.message || 'unknown error'
      });
    });

    const proxyServer = app.listen(config.PORT, () => {
      logger.info('reverse proxy started', {
        port: config.PORT,
        target: config.REVERSE_PROXY_TARGET
      });
    });
    proxyServer.keepAliveTimeout = 65_000;
    proxyServer.headersTimeout = 66_000;
    return;
  }

  const cacheManager = new CacheManager();

  await cacheManager.initialize();

  const sourceRegistry = new SourceRegistry();
  const imdbResolver = new ImdbResolverService();
  const providerService = new ProviderService();
  await providerService.initialize();
  const userTracker = new UserTrackerService();
  await userTracker.initialize();
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

  app.use((req, _res, next) => {
    userTracker.trackRequest(req);
    next();
  });
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, Accept, Origin, User-Agent');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type');

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.use(express.urlencoded({ extended: false, limit: '8kb' }));
  app.use('/assets', express.static('assets', {
    maxAge: '7d',
    immutable: true
  }));
  app.use(createRateLimiter({
    name: 'public',
    windowMs: config.PUBLIC_RATE_LIMIT_WINDOW_SECONDS * 1000,
    limit: config.PUBLIC_RATE_LIMIT_MAX_REQUESTS,
    matcher: (req) => {
      if (req.path.startsWith('/admin')) {
        return false;
      }

      return req.path === '/' || req.path === '/configure' || req.path === '/manifest.json' || req.path === '/stremio/manifest.json' || req.path.startsWith('/configured/');
    }
  }));
  app.use(createRateLimiter({
    name: 'streams',
    windowMs: config.STREAM_RATE_LIMIT_WINDOW_SECONDS * 1000,
    limit: config.STREAM_RATE_LIMIT_MAX_REQUESTS,
    matcher: (req) => req.path.startsWith('/stream/')
      || req.path === '/stream'
      || req.path === '/http-stream'
      || req.path === '/stream/http'
      || req.path === '/stream/torrent'
      || req.path.startsWith('/stremio/stream/')
  }));
  app.use(createRateLimiter({
    name: 'providers',
    windowMs: config.PROVIDER_RATE_LIMIT_WINDOW_SECONDS * 1000,
    limit: config.PROVIDER_RATE_LIMIT_MAX_REQUESTS,
    matcher: (req) => req.path.startsWith('/providers')
  }));

  app.get('/health', async (_req, res, next) => {
    try {
      const cacheStats = await cacheManager.getCacheStats(torrentEngine.getActiveCachePaths());

      res.json({
        status: 'ok',
        uptimeSeconds: Math.round(process.uptime()),
        activeTorrentEngines: torrentEngine.getActiveCachePaths().length,
        activeStreams: streamManager.activeStreams,
        maxActiveStreams: config.MAX_ACTIVE_STREAMS,
        users: userTracker.getStats(),
        cache: cacheStats
      });
    } catch (error) {
      next(error);
    }
  });

  const renderConfigureResponse = (req, res) => {
    res
      .status(200)
      .type('html')
      .send(renderConfigurePage({
        baseUrl: getPublicBaseUrl(req),
        providers: providerService.listProviders()
      }));
  };

  app.get('/', renderConfigureResponse);
  app.get('/configure', renderConfigureResponse);

  app.get('/donate', (req, res) => {
    res
      .status(200)
      .type('html')
      .send(renderDonatePage({
        baseUrl: getPublicBaseUrl(req)
      }));
  });

  app.get('/admin/login', (req, res) => {
    if (hasValidAdminSession(req)) {
      res.redirect(302, '/admin');
      return;
    }

    res.status(200).type('html').send(renderAdminLoginPage({
      errorMessage: req.query.error === 'invalid' ? 'Invalid admin credentials.' : ''
    }));
  });

  app.post('/admin/login', (req, res) => {
    const { username = '', password = '' } = req.body ?? {};

    if (username !== config.ADMIN_USERNAME || password !== config.ADMIN_PASSWORD) {
      clearAdminSessionCookie(res);
      res.redirect(302, '/admin/login?error=invalid');
      return;
    }

    setAdminSessionCookie(req, res);
    res.redirect(302, '/admin');
  });

  app.post('/admin/logout', (req, res) => {
    clearAdminSessionCookie(res);
    res.redirect(302, '/admin/login');
  });

  app.get('/admin', requireAdminAuth, async (req, res, next) => {
    try {
      const systemStats = await getSystemStats();
      const cacheStats = await cacheManager.getCacheStats(torrentEngine.getActiveCachePaths());
      const stats = {
        runtime: {
          uptimeSeconds: Math.round(process.uptime()),
          activeTorrentEngines: torrentEngine.getActiveCachePaths().length,
          activeStreams: streamManager.activeStreams,
          maxActiveStreams: config.MAX_ACTIVE_STREAMS
        },
        system: systemStats,
        users: userTracker.getStats(),
        cache: cacheStats,
        providers: providerService.getStats(),
        sourceRegistry: sourceRegistry.getStats()
      };

      res.status(200).type('html').send(renderAdminPage({ stats }));
    } catch (error) {
      next(error);
    }
  });

  app.get('/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/stremio/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/configured/:providerConfig/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/configured/:providerConfig/stremio/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/stremio/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/stremio/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/stremio/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/configured/:providerConfig/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/configured/:providerConfig/stremio/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/stremio/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/stremio/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
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
    await userTracker.close();
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
