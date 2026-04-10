import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const { mkdir, readFile, writeFile } = fsPromises;

const FLUSH_DELAY_MS = 5000;
const USERS_FILE = path.join(config.CACHE_DIR, 'analytics', 'users.json');
const BOT_USER_AGENT_PATTERN = /\b(bot|crawler|spider|validator|preview|headless|curl|wget|python-requests|go-http-client|facebookexternalhit|slackbot|discordbot)\b/i;

const nowIso = () => new Date().toISOString();

const getClientIp = (headers, fallbackIp) => {
  const forwarded = headers['x-forwarded-for'];

  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  return String(fallbackIp || '').trim();
};

const getTrackedPathType = (pathname) => {
  if (
    pathname === '/manifest.json'
    || pathname === '/stremio/manifest.json'
    || pathname.endsWith('/manifest.json')
  ) {
    return 'manifest';
  }

  if (
    pathname === '/stream'
    || pathname === '/http-stream'
    || pathname === '/stream/http'
    || pathname === '/stream/torrent'
    || pathname.startsWith('/stream/')
    || pathname.startsWith('/stremio/stream/')
    || pathname.includes('/stream/')
  ) {
    return 'stream';
  }

  return null;
};

const isObviousBot = (headers) => {
  const userAgent = String(headers?.['user-agent'] || '').trim();

  if (!userAgent) {
    return true;
  }

  return BOT_USER_AGENT_PATTERN.test(userAgent);
};

const createEmptyEntry = () => ({
  firstSeenAt: nowIso(),
  lastSeenAt: nowIso(),
  hits: 0,
  humanHits: 0,
  botHits: 0,
  streamHits: 0,
  manifestHits: 0
});

export class UserTrackerService {
  constructor() {
    this.entries = new Map();
    this.totalRequests = 0;
    this.totalHumanRequests = 0;
    this.totalBotRequests = 0;
    this.totalStreamRequests = 0;
    this.totalManifestRequests = 0;
    this.flushTimer = null;
    this.flushInFlight = null;
  }

  async initialize() {
    await mkdir(path.dirname(USERS_FILE), { recursive: true });

    try {
      const payload = JSON.parse(await readFile(USERS_FILE, 'utf8'));

      this.totalRequests = Number.isInteger(payload.totalRequests) ? payload.totalRequests : 0;
      this.totalHumanRequests = Number.isInteger(payload.totalHumanRequests) ? payload.totalHumanRequests : 0;
      this.totalBotRequests = Number.isInteger(payload.totalBotRequests) ? payload.totalBotRequests : 0;
      this.totalStreamRequests = Number.isInteger(payload.totalStreamRequests) ? payload.totalStreamRequests : 0;
      this.totalManifestRequests = Number.isInteger(payload.totalManifestRequests) ? payload.totalManifestRequests : 0;

      if (payload.users && typeof payload.users === 'object') {
        for (const [fingerprint, user] of Object.entries(payload.users)) {
          this.entries.set(fingerprint, {
            firstSeenAt: user.firstSeenAt || nowIso(),
            lastSeenAt: user.lastSeenAt || nowIso(),
            hits: Number.isInteger(user.hits) ? user.hits : 0,
            humanHits: Number.isInteger(user.humanHits) ? user.humanHits : 0,
            botHits: Number.isInteger(user.botHits) ? user.botHits : 0,
            streamHits: Number.isInteger(user.streamHits) ? user.streamHits : 0,
            manifestHits: Number.isInteger(user.manifestHits) ? user.manifestHits : 0
          });
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn('user tracker state load failed', { error });
      }
    }
  }

  trackRequest(req) {
    const pathname = req.path || '';
    const trackedPathType = getTrackedPathType(pathname);

    if (!trackedPathType) {
      return;
    }

    const fingerprint = this.getFingerprint(req);
    const entry = this.entries.get(fingerprint) || createEmptyEntry();
    const botRequest = isObviousBot(req.headers || {});

    entry.lastSeenAt = nowIso();
    entry.hits += 1;

    if (botRequest) {
      entry.botHits += 1;
      this.totalBotRequests += 1;
    } else {
      entry.humanHits += 1;
      this.totalHumanRequests += 1;
    }

    if (trackedPathType === 'stream') {
      entry.streamHits += 1;
      this.totalStreamRequests += 1;
    } else if (trackedPathType === 'manifest') {
      entry.manifestHits += 1;
      this.totalManifestRequests += 1;
    }

    this.entries.set(fingerprint, entry);
    this.totalRequests += 1;
    this.scheduleFlush();
  }

  getStats() {
    const now = Date.now();
    let active24h = 0;
    let active7d = 0;
    let totalHumanUsers = 0;
    let streamUsers = 0;
    let botClients = 0;
    let mixedClients = 0;

    for (const entry of this.entries.values()) {
      const lastSeenMs = Date.parse(entry.lastSeenAt || '');
      const humanOnly = entry.humanHits > 0 && entry.botHits === 0;
      const botOnly = entry.botHits > 0 && entry.humanHits === 0;
      const mixed = entry.botHits > 0 && entry.humanHits > 0;

      if (humanOnly) {
        totalHumanUsers += 1;

        if (entry.streamHits > 0) {
          streamUsers += 1;
        }
      } else if (botOnly) {
        botClients += 1;
      } else if (mixed) {
        mixedClients += 1;
      }

      if (!humanOnly || !Number.isFinite(lastSeenMs)) {
        continue;
      }

      if (now - lastSeenMs <= 24 * 60 * 60 * 1000) {
        active24h += 1;
      }

      if (now - lastSeenMs <= 7 * 24 * 60 * 60 * 1000) {
        active7d += 1;
      }
    }

    return {
      totalUsers: totalHumanUsers,
      activeUsers24h: active24h,
      activeUsers7d: active7d,
      totalTrackedRequests: this.totalHumanRequests,
      rawUniqueClients: this.entries.size,
      rawTrackedRequests: this.totalRequests,
      botClients,
      botRequests: this.totalBotRequests,
      mixedClients,
      streamUsers,
      streamRequests: this.totalStreamRequests,
      manifestRequests: this.totalManifestRequests
    };
  }

  async close() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    await this.flush();
  }

  getFingerprint(req) {
    const ip = getClientIp(req.headers || {}, req.ip);
    const userAgent = String(req.headers?.['user-agent'] || '').trim();
    const language = String(req.headers?.['accept-language'] || '').trim();
    const payload = `${ip}|${userAgent}|${language}`;

    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  scheduleFlush() {
    if (this.flushTimer || this.flushInFlight) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((error) => {
        logger.warn('user tracker flush failed', { error });
      });
    }, FLUSH_DELAY_MS);

    this.flushTimer.unref();
  }

  async flush() {
    if (this.flushInFlight) {
      await this.flushInFlight;
      return;
    }

    const payload = {
      totalRequests: this.totalRequests,
      totalHumanRequests: this.totalHumanRequests,
      totalBotRequests: this.totalBotRequests,
      totalStreamRequests: this.totalStreamRequests,
      totalManifestRequests: this.totalManifestRequests,
      users: Object.fromEntries(this.entries.entries())
    };

    this.flushInFlight = writeFile(USERS_FILE, JSON.stringify(payload));

    try {
      await this.flushInFlight;
    } finally {
      this.flushInFlight = null;
    }
  }
}
