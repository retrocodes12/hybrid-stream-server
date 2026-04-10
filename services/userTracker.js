import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const { mkdir, readFile, writeFile } = fsPromises;

const FLUSH_DELAY_MS = 5000;
const USERS_FILE = path.join(config.CACHE_DIR, 'analytics', 'users.json');

const nowIso = () => new Date().toISOString();

const getClientIp = (headers, fallbackIp) => {
  const forwarded = headers['x-forwarded-for'];

  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  return String(fallbackIp || '').trim();
};

const shouldTrackPath = (pathname) => (
  pathname === '/manifest.json'
  || pathname === '/stremio/manifest.json'
  || pathname === '/configure'
  || pathname === '/stream'
  || pathname === '/http-stream'
  || pathname === '/stream/http'
  || pathname === '/stream/torrent'
  || pathname.startsWith('/stream/')
  || pathname.startsWith('/stremio/stream/')
  || pathname.startsWith('/configured/')
);

export class UserTrackerService {
  constructor() {
    this.entries = new Map();
    this.totalRequests = 0;
    this.flushTimer = null;
    this.flushInFlight = null;
  }

  async initialize() {
    await mkdir(path.dirname(USERS_FILE), { recursive: true });

    try {
      const payload = JSON.parse(await readFile(USERS_FILE, 'utf8'));

      this.totalRequests = Number.isInteger(payload.totalRequests) ? payload.totalRequests : 0;

      if (payload.users && typeof payload.users === 'object') {
        for (const [fingerprint, user] of Object.entries(payload.users)) {
          this.entries.set(fingerprint, {
            firstSeenAt: user.firstSeenAt || nowIso(),
            lastSeenAt: user.lastSeenAt || nowIso(),
            hits: Number.isInteger(user.hits) ? user.hits : 0
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

    if (!shouldTrackPath(pathname)) {
      return;
    }

    const fingerprint = this.getFingerprint(req);
    const entry = this.entries.get(fingerprint);

    if (entry) {
      entry.lastSeenAt = nowIso();
      entry.hits += 1;
    } else {
      this.entries.set(fingerprint, {
        firstSeenAt: nowIso(),
        lastSeenAt: nowIso(),
        hits: 1
      });
    }

    this.totalRequests += 1;
    this.scheduleFlush();
  }

  getStats() {
    const now = Date.now();
    let active24h = 0;
    let active7d = 0;

    for (const entry of this.entries.values()) {
      const lastSeenMs = Date.parse(entry.lastSeenAt || '');

      if (!Number.isFinite(lastSeenMs)) {
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
      totalUsers: this.entries.size,
      activeUsers24h: active24h,
      activeUsers7d: active7d,
      totalTrackedRequests: this.totalRequests
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
