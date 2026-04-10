import crypto from 'node:crypto';
import express from 'express';

import { config } from './config.js';
import { CacheManager } from './services/cacheManager.js';
import { HttpProxyService } from './services/httpProxy.js';
import { ImdbResolverService } from './services/imdbResolver.js';
import { ProviderService } from './services/providerService.js';
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

const renderConfigurePage = ({ baseUrl, providers }) => {
  const providerIds = providers.map((provider) => provider.id);
  const providerHints = providers
    .slice(0, 12)
    .map((provider) => escapeHtml(provider.id))
    .join(', ');
  const hasDonationSupport = Boolean(
    config.DONATION_CRYPTO_ADDRESS ||
    config.DONATION_PRIMARY_URL ||
    config.DONATION_SECONDARY_URL ||
    config.DONATION_UPI_ID
  );
  const donateCryptoLabel = escapeHtml(config.DONATION_CRYPTO_LABEL || 'USDT (TRC20)');
  const donateCryptoAddress = escapeHtml(config.DONATION_CRYPTO_ADDRESS || '');
  const donatePrimaryUrl = escapeHtml(config.DONATION_PRIMARY_URL || '');
  const donateSecondaryUrl = escapeHtml(config.DONATION_SECONDARY_URL || '');
  const donateUpiId = escapeHtml(config.DONATION_UPI_ID || '');

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
        width: min(100%, 560px);
      }

      .shell {
        position: relative;
        overflow: hidden;
        padding: 34px 28px 24px;
        border-radius: 28px;
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
        margin: 18px 0 10px;
        font-size: clamp(32px, 8vw, 48px);
        line-height: 1.05;
      }

      .subtitle {
        margin: 0;
        color: var(--muted);
        font-size: 16px;
      }

      .field {
        margin-top: 28px;
      }

      .field-label {
        display: block;
        margin-bottom: 10px;
        color: #dfe6ff;
        font-size: 13px;
      }

      .field-input {
        width: 100%;
        padding: 15px 16px;
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 18px;
        background: var(--surface);
        color: var(--text);
        font: inherit;
        outline: none;
        transition: border-color 140ms ease, box-shadow 140ms ease, transform 140ms ease;
      }

      .field-input::placeholder {
        color: #8d96b0;
      }

      .field-input:focus {
        border-color: rgba(99, 102, 241, 0.6);
        box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.14);
        transform: translateY(-1px);
      }

      .field-help {
        margin-top: 10px;
        color: var(--muted);
        font-size: 13px;
      }

      .manifest-box {
        margin-top: 18px;
        padding: 16px;
        border-radius: 18px;
        background: rgba(12, 14, 22, 0.45);
        border: 1px solid rgba(255,255,255,0.08);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.05);
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
        transition: transform 140ms ease, box-shadow 160ms ease, opacity 140ms ease;
      }

      button:hover {
        transform: translateY(-1px);
      }

      button:active {
        transform: translateY(0);
      }

      .primary-button {
        background: linear-gradient(135deg, var(--accent-start), var(--accent-end));
        color: #f8fbff;
        box-shadow: 0 12px 30px rgba(99, 102, 241, 0.28);
      }

      .primary-button:hover {
        box-shadow: 0 16px 36px rgba(99, 102, 241, 0.34);
      }

      .secondary-button {
        background: rgba(255,255,255,0.06);
        color: var(--text);
        border: 1px solid rgba(255,255,255,0.08);
      }

      .secondary-button:hover {
        box-shadow: 0 0 0 1px rgba(255,255,255,0.08), 0 10px 28px rgba(0,0,0,0.22);
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
        text-align: center;
      }
      .notes-list {
        display: grid;
        gap: 10px;
      }
      .note-item {
        margin: 0;
        color: var(--muted);
        font-size: 14px;
        text-align: center;
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
        text-align: center;
        line-height: 1.6;
      }
      .disclaimer-text strong {
        color: #ff929f;
      }

      .support {
        margin-top: 22px;
        padding-top: 18px;
        border-top: 1px solid rgba(255,255,255,0.08);
      }
      .support-promo {
        margin-top: 18px;
        padding: 16px 18px 18px;
        border-radius: 22px;
        border: 1px solid rgba(255,255,255,0.1);
        background: rgba(255,255,255,0.04);
        box-shadow: 0 14px 34px rgba(0,0,0,0.18);
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
        margin-top: 14px;
        min-height: 42px;
        padding: 0 16px;
        border-radius: 999px;
        text-decoration: none;
        color: #f8fbff;
        background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.1);
        transition: transform 140ms ease, box-shadow 160ms ease, background 140ms ease;
      }
      .support-link:hover {
        transform: translateY(-1px);
        background: rgba(255,255,255,0.11);
        box-shadow: 0 10px 24px rgba(0,0,0,0.2);
      }
      .free-strip {
        display: flex;
        align-items: center;
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
        min-width: 118px;
        padding: 12px 16px;
        border-radius: 14px;
        border: 0;
        background: linear-gradient(135deg, rgba(34,197,94,0.95), rgba(16,185,129,0.95));
        color: #f7fffb;
        box-shadow: 0 12px 24px rgba(16,185,129,0.22);
      }
      .donate-toggle.close-state {
        background: rgba(255,255,255,0.08);
        color: #eef2ff;
        box-shadow: none;
      }
      .donation-panel {
        display: none;
        margin-top: 16px;
        padding: 18px;
        border-radius: 22px;
        background: linear-gradient(180deg, rgba(255,255,255,0.07), rgba(255,255,255,0.03));
        border: 1px solid rgba(255,255,255,0.09);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.06);
      }
      .donation-panel.open {
        display: block;
      }
      .donation-shell {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 176px;
        gap: 16px;
      }
      .donation-title {
        margin: 0;
        font-size: 28px;
        line-height: 1.05;
      }
      .donation-subtitle {
        margin: 8px 0 0;
        color: var(--muted);
        font-size: 14px;
      }
      .donation-fields {
        display: grid;
        gap: 14px;
        margin-top: 16px;
      }
      .donation-methods {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .donation-method {
        appearance: none;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 999px;
        padding: 12px 16px;
        background: rgba(255,255,255,0.04);
        color: var(--text);
        cursor: pointer;
        font: inherit;
        transition: transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease, background 140ms ease;
      }
      .donation-method:hover {
        transform: translateY(-1px);
      }
      .donation-method.active {
        background: linear-gradient(135deg, rgba(139, 92, 246, 0.28), rgba(59, 130, 246, 0.22));
        border-color: rgba(123, 97, 255, 0.5);
        box-shadow: 0 10px 22px rgba(99, 102, 241, 0.18);
      }
      .donation-hint {
        margin: 4px 0 0;
        color: var(--muted);
        font-size: 12px;
      }
      .donation-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 14px;
      }
      .mini-button {
        appearance: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 42px;
        padding: 0 14px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.06);
        color: var(--text);
        text-decoration: none;
        cursor: pointer;
        font: inherit;
        transition: transform 140ms ease, box-shadow 140ms ease, background 140ms ease;
      }
      .mini-button:hover {
        transform: translateY(-1px);
        background: rgba(255,255,255,0.1);
      }
      .mini-button.primary {
        border: 0;
        background: linear-gradient(135deg, var(--accent-start), var(--accent-end));
        color: #f7fbff;
        box-shadow: 0 12px 26px rgba(99, 102, 241, 0.22);
      }
      .wallet-box {
        margin-top: 14px;
        padding: 14px;
        border-radius: 16px;
        background: rgba(12,14,22,0.42);
        border: 1px solid rgba(255,255,255,0.07);
      }
      .wallet-label {
        margin: 0 0 8px;
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .wallet-address {
        margin: 0;
        color: #eef2ff;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 13px;
        line-height: 1.55;
        word-break: break-word;
      }
      .qr-side {
        display: grid;
        align-content: start;
        gap: 10px;
      }
      .qr-frame {
        display: grid;
        place-items: center;
        aspect-ratio: 1;
        border-radius: 20px;
        background: rgba(255,255,255,0.98);
        overflow: hidden;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.95), 0 14px 28px rgba(0,0,0,0.18);
      }
      .qr-frame img {
        width: 88%;
        height: 88%;
        object-fit: contain;
      }
      .qr-note {
        color: var(--muted);
        font-size: 12px;
        text-align: center;
      }

      .support-title {
        margin: 0 0 6px;
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #d9def4;
      }

      .support p {
        margin: 0;
        color: var(--muted);
        font-size: 14px;
      }

      .support a {
        color: #c5d3ff;
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
        .free-strip {
          flex-direction: column;
          align-items: stretch;
        }
        .donation-shell {
          grid-template-columns: 1fr;
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
          <p class="subtitle">Self-hosted streaming backend</p>

          <div class="field">
            <label class="field-label" for="provider-input">Optional provider filter</label>
            <input
              id="provider-input"
              class="field-input"
              type="text"
              list="provider-list"
              placeholder="cinestream,4khdhub,streamflix"
              spellcheck="false"
              autocomplete="off"
            >
            <div class="field-help">Leave blank to use all providers. Example: ${providerHints || '4khdhub,cinestream,streamflix'}</div>
            <datalist id="provider-list">
              ${providerIds.map((providerId) => `<option value="${escapeHtml(providerId)}"></option>`).join('')}
            </datalist>
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
              <p class="note-item"><strong>Playback compatibility:</strong> lighter MP4 or HLS sources usually work best with Stremio native players. Heavy MKV, HEVC, HDR, or 10-bit files may work better in VLC or another external player.</p>
              <p class="note-item"><strong>Provider matches:</strong> NebulaStreams aggregates results from public sources. A stream can occasionally be missing, slow, or imperfect, so if one card fails, try another source.</p>
              <p class="note-item"><strong>Cold starts:</strong> the first request can take longer while the hosted backend wakes up and providers are queried in parallel.</p>
              <p class="note-item"><strong>Media hosting:</strong> NebulaStreams does not store the media files themselves. It discovers external links and passes them through the configured playback flow.</p>
            </div>
            <div class="disclaimer">
              <p class="disclaimer-text"><strong>Disclaimer:</strong> NebulaStreams is a stream discovery tool. It does not host, upload, or own the media itself. Always respect the laws and content rights in your region.</p>
            </div>
          </div>

          <div class="support">
            <div class="support-title">Support</div>
            <p>Use the manifest directly in Stremio if install does not open automatically. You can also paste a small provider list above to keep results focused.</p>
            ${hasDonationSupport ? `
              <div class="support-promo">
                <div class="free-strip">
                  <div class="free-copy">
                    <div class="free-title">This addon is <strong>completely free</strong>.</div>
                    <p>You can donate to support the developer and keep this project alive.</p>
                  </div>
                  <button type="button" class="donate-toggle" id="donate-toggle">
                    <span>♥</span>
                    <span id="donate-toggle-text">Donate</span>
                  </button>
                </div>
                <div class="donation-panel" id="donation-panel">
                  <div class="donation-shell">
                    <div>
                      <h3 class="donation-title">Donation</h3>
                      <p class="donation-subtitle">Support NebulaStreams directly with crypto. Use the wallet or QR and send on the exact network shown below.</p>
                      <div class="donation-fields">
                        <div class="donation-methods" id="donation-methods">
                          ${config.DONATION_CRYPTO_ADDRESS ? `<button type="button" class="donation-method active" data-method="crypto">${donateCryptoLabel}</button>` : ''}
                          ${config.DONATION_UPI_ID ? `<button type="button" class="donation-method" data-method="upi">UPI</button>` : ''}
                        </div>
                        <p class="donation-hint" id="donation-hint">Open the wallet flow directly or scan the QR to load the destination in a supported wallet.</p>
                      </div>
                      <div class="wallet-box">
                        <div class="wallet-label" id="wallet-label">${config.DONATION_CRYPTO_ADDRESS ? donateCryptoLabel : 'Payment method'}</div>
                        <p class="wallet-address" id="wallet-address">${config.DONATION_CRYPTO_ADDRESS ? donateCryptoAddress : donateUpiId}</p>
                      </div>
                      <div class="donation-actions">
                        <a class="mini-button primary" href="#" id="open-wallet-link">Open in Wallet</a>
                        <button type="button" class="mini-button primary" id="copy-donation-address">Copy address</button>
                        <a class="mini-button" href="${escapeHtml(baseUrl)}/donate">Open full donation page</a>
                        ${config.DONATION_PRIMARY_URL ? `<a class="mini-button" href="${donatePrimaryUrl}" target="_blank" rel="noopener">External checkout</a>` : ''}
                        ${config.DONATION_SECONDARY_URL ? `<a class="mini-button" href="${donateSecondaryUrl}" target="_blank" rel="noopener">More options</a>` : ''}
                      </div>
                    </div>
                    <div class="qr-side">
                      <div class="qr-frame">
                        <img id="donation-qr" alt="Donation QR">
                      </div>
                      <div class="qr-note">Scan to open the payment address quickly in your wallet.</div>
                    </div>
                  </div>
                </div>
              </div>
            ` : `
              <div class="support-promo">
                <div class="support-promo-head">
                  <div class="support-promo-title">Feeling generous?</div>
                  <div class="support-hearts">♥ ♥ ♥</div>
                </div>
                <p class="support-promo-copy">If NebulaStreams saves you time, helps your setup, or just feels solid, you can support the project and keep it improving.</p>
                <a class="support-link" href="${escapeHtml(baseUrl)}/donate">Open Donation Page</a>
              </div>
            `}
          </div>
        </div>
      </section>
    </main>
    <script>
      const origin = ${JSON.stringify(baseUrl)};
      const providerIds = ${JSON.stringify(providerIds)};
      const providerInput = document.getElementById('provider-input');
      const manifestUrl = document.getElementById('manifest-url');
      const flash = document.getElementById('flash');
      const copyButton = document.getElementById('copy-url');
      const installButton = document.getElementById('install-addon');
      const donateToggle = document.getElementById('donate-toggle');
      const donateToggleText = document.getElementById('donate-toggle-text');
      const donationPanel = document.getElementById('donation-panel');
      const donationMethodsElement = document.getElementById('donation-methods');
      const donationQr = document.getElementById('donation-qr');
      const walletLabel = document.getElementById('wallet-label');
      const walletAddress = document.getElementById('wallet-address');
      const copyDonationAddress = document.getElementById('copy-donation-address');
      const openWalletLink = document.getElementById('open-wallet-link');
      const donationHint = document.getElementById('donation-hint');
      let activeDonationMethod = donationMethods.crypto.value ? 'crypto' : 'upi';
      const donationMethods = {
        crypto: {
          label: ${JSON.stringify(config.DONATION_CRYPTO_ADDRESS ? config.DONATION_CRYPTO_LABEL || 'USDT (TRC20)' : '')},
          displayValue: ${JSON.stringify(config.DONATION_CRYPTO_ADDRESS || '')},
          value: ${JSON.stringify(config.DONATION_CRYPTO_ADDRESS || '')},
          copyLabel: 'Copy address',
          openLabel: 'Open in Wallet',
          walletUrl: ${JSON.stringify(
            config.DONATION_CRYPTO_ADDRESS
              ? `https://link.trustwallet.com/send?asset=c195_tTR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t&address=${config.DONATION_CRYPTO_ADDRESS}`
              : ''
          )}
        },
        upi: {
          label: 'UPI',
          displayValue: 'UPI is ready. Open the app or copy the ID.',
          value: ${JSON.stringify(config.DONATION_UPI_ID || '')},
          copyLabel: 'Copy UPI ID',
          openLabel: 'Open UPI App',
          walletUrl: ${JSON.stringify(
            config.DONATION_UPI_ID
              ? `upi://pay?pa=${encodeURIComponent(config.DONATION_UPI_ID)}`
              : ''
          )}
        }
      };

      const update = () => {
        const rawValue = providerInput.value
          .split(',')
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean);
        const uniqueValues = rawValue.filter((value, index) => rawValue.indexOf(value) === index);
        const filteredProviders = uniqueValues.filter((value) => providerIds.includes(value));
        const providerSegment = filteredProviders.length > 0
          ? encodeURIComponent(filteredProviders.join(','))
          : 'all';

        manifestUrl.textContent = filteredProviders.length > 0
          ? origin + '/configured/' + providerSegment + '/manifest.json'
          : origin + '/manifest.json';
      };

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

      const setDonationMethod = () => {
        if (!walletLabel || !walletAddress || !donationQr) {
          return;
        }

        const method = activeDonationMethod === 'upi' && donationMethods.upi.value
          ? donationMethods.upi
          : donationMethods.crypto.value
            ? donationMethods.crypto
            : donationMethods.upi;

        walletLabel.textContent = method.label || 'Payment method';
        walletAddress.textContent = method.displayValue || method.value || 'Not configured';
        donationQr.src = method.walletUrl
          ? 'https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=8&data=' + encodeURIComponent(method.walletUrl)
          : '';

        if (donationHint) {
          donationHint.textContent = method.value
            ? 'Use the wallet button or scan the QR to open ' + method.label + ' in a compatible app.'
            : 'No donation method is configured yet.';
        }

        if (openWalletLink) {
          if (method.walletUrl) {
            openWalletLink.href = method.walletUrl;
            openWalletLink.style.display = 'inline-flex';
            openWalletLink.textContent = method.openLabel || 'Open';
          } else {
            openWalletLink.href = '#';
            openWalletLink.style.display = 'none';
          }
        }

        if (copyDonationAddress) {
          copyDonationAddress.textContent = method.copyLabel || 'Copy';
          copyDonationAddress.dataset.copyValue = method.value || '';
        }

        if (donationMethodsElement) {
          donationMethodsElement.querySelectorAll('.donation-method').forEach((button) => {
            button.classList.toggle('active', button.dataset.method === activeDonationMethod);
          });
        }
      };

      const getManifestUrl = () => manifestUrl.textContent.trim();

      installButton.addEventListener('click', () => {
        const url = 'stremio://addon-install?addon=' + encodeURIComponent(getManifestUrl());
        window.location.href = url;
      });

      copyButton.addEventListener('click', async () => {
        const manifest = getManifestUrl();

        try {
          await copyText(manifest, 'Manifest URL copied.');
        } catch {}
      });

      if (donateToggle && donationPanel) {
        donateToggle.addEventListener('click', () => {
          const isOpen = donationPanel.classList.toggle('open');
          donateToggle.classList.toggle('close-state', isOpen);

          if (donateToggleText) {
            donateToggleText.textContent = isOpen ? 'Close' : 'Donate';
          }
        });
      }

      if (donationMethodsElement) {
        donationMethodsElement.addEventListener('click', (event) => {
          const button = event.target.closest('.donation-method');

          if (!button) {
            return;
          }

          activeDonationMethod = button.dataset.method === 'upi' ? 'upi' : 'crypto';
          setDonationMethod();
        });
        setDonationMethod();
      }

      if (copyDonationAddress && walletAddress) {
        copyDonationAddress.addEventListener('click', () => {
          const rawValue = copyDonationAddress.dataset.copyValue || walletAddress.textContent.trim();
          const successMessage = activeDonationMethod === 'upi'
            ? 'UPI ID copied.'
            : 'Donation address copied.';
          void copyText(rawValue, successMessage);
        });
      }

      providerInput.addEventListener('input', update);
      update();
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
        <div class="card"><div class="label">Active Streams</div><div class="value">${stats.runtime.activeStreams}/${stats.runtime.maxActiveStreams}</div></div>
        <div class="card"><div class="label">Active Torrents</div><div class="value">${stats.runtime.activeTorrentEngines}</div></div>
        <div class="card"><div class="label">Total Users</div><div class="value">${stats.users.totalUsers}</div></div>
        <div class="card"><div class="label">Users 24h</div><div class="value">${stats.users.activeUsers24h}</div></div>
        <div class="card"><div class="label">Tracked Requests</div><div class="value">${stats.users.totalTrackedRequests}</div></div>
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
  const cryptoLabel = config.DONATION_CRYPTO_LABEL || 'Crypto';
  const cryptoAddress = config.DONATION_CRYPTO_ADDRESS || '';
  const primaryButton = config.DONATION_PRIMARY_URL
    ? `<a class="button button-primary" href="${escapeHtml(config.DONATION_PRIMARY_URL)}" target="_blank" rel="noopener">Support NebulaStreams</a>`
    : '';
  const secondaryButton = config.DONATION_SECONDARY_URL
    ? `<a class="button button-secondary" href="${escapeHtml(config.DONATION_SECONDARY_URL)}" target="_blank" rel="noopener">Alternative Payment</a>`
    : '';
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
  const cryptoSection = config.DONATION_CRYPTO_ADDRESS
    ? `
      <section class="payment-panel">
        <div class="qr-card">
          <div class="qr-shell">
            <img id="crypto-qr" alt="${escapeHtml(cryptoLabel)} QR">
          </div>
          <div class="qr-help">Scan with any wallet that supports ${escapeHtml(cryptoLabel)}.</div>
        </div>
        <div class="payment-details">
          <div class="support-card">
            <div class="support-label">Network</div>
            <div class="support-value">${escapeHtml(cryptoLabel)}</div>
          </div>
          <div class="support-card">
            <div class="support-label">Wallet address</div>
            <div class="support-value mono" id="crypto-value">${escapeHtml(cryptoAddress)}</div>
            <button type="button" class="copy-button" id="copy-crypto">Copy Wallet Address</button>
          </div>
        </div>
      </section>
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
      .actions {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
        margin-top: 22px;
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
      .payment-panel {
        display: grid;
        grid-template-columns: 220px minmax(0, 1fr);
        gap: 16px;
        margin-top: 22px;
      }
      .payment-details {
        display: grid;
        gap: 14px;
      }
      .qr-card,
      .support-card {
        padding: 18px;
        border-radius: 22px;
        background: rgba(255,255,255,0.045);
        border: 1px solid rgba(255,255,255,0.08);
      }
      .qr-card {
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        align-items: center;
      }
      .qr-shell {
        display: grid;
        place-items: center;
        width: 100%;
        aspect-ratio: 1;
        border-radius: 20px;
        background: rgba(255,255,255,0.96);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.85), 0 14px 34px rgba(0,0,0,0.18);
        overflow: hidden;
      }
      .qr-shell img {
        width: 86%;
        height: 86%;
        object-fit: contain;
      }
      .qr-help {
        margin-top: 14px;
        color: var(--muted);
        font-size: 13px;
        text-align: center;
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
      .mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 15px;
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
        .actions {
          grid-template-columns: 1fr;
        }
        .payment-panel {
          grid-template-columns: 1fr;
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

          ${primaryButton || secondaryButton ? `<div class="actions">${primaryButton}${secondaryButton}</div>` : ''}

          ${cryptoSection}
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

  app.disable('x-powered-by');
  app.set('trust proxy', true);
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
        baseUrl: `${req.protocol}://${req.get('host')}`,
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
        baseUrl: `${req.protocol}://${req.get('host')}`
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
      const cacheStats = await cacheManager.getCacheStats(torrentEngine.getActiveCachePaths());
      const stats = {
        runtime: {
          uptimeSeconds: Math.round(process.uptime()),
          activeTorrentEngines: torrentEngine.getActiveCachePaths().length,
          activeStreams: streamManager.activeStreams,
          maxActiveStreams: config.MAX_ACTIVE_STREAMS
        },
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
