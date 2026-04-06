import crypto from 'node:crypto';

import { logger } from '../utils/logger.js';

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

export class SourceRegistry {
  constructor({ ttlMs = DEFAULT_TTL_MS } = {}) {
    this.ttlMs = ttlMs;
    this.entries = new Map();
    this.cleanupTimer = setInterval(() => {
      this.removeExpired();
    }, CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  register({ type, source, headers = null, metadata = null }) {
    const id = crypto.randomBytes(12).toString('hex');
    const expiresAt = Date.now() + this.ttlMs;

    this.entries.set(id, {
      type,
      source,
      headers: headers && Object.keys(headers).length > 0 ? { ...headers } : null,
      metadata: metadata ? { ...metadata } : null,
      expiresAt,
      createdAt: Date.now(),
      lastAccessedAt: Date.now()
    });

    return id;
  }

  get(id) {
    const entry = this.entries.get(id);

    if (!entry) {
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(id);
      return null;
    }

    entry.lastAccessedAt = Date.now();
    return {
      ...entry,
      headers: entry.headers ? { ...entry.headers } : null,
      metadata: entry.metadata ? { ...entry.metadata } : null
    };
  }

  close() {
    clearInterval(this.cleanupTimer);
    this.entries.clear();
  }

  removeExpired() {
    const now = Date.now();

    for (const [id, entry] of this.entries.entries()) {
      if (entry.expiresAt <= now) {
        this.entries.delete(id);
      }
    }
  }

  getStats() {
    return {
      entries: this.entries.size,
      ttlMs: this.ttlMs
    };
  }
}
