import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';
import { config, cacheConfig } from '../config.js';
import { enhanceMagnet, extractInfoHash } from '../utils/magnet.js';
import { logger } from '../utils/logger.js';

const { mkdir, readFile, rm, writeFile } = fsPromises;

const detectSourceType = (source) => {
  const normalized = String(source || '').trim();

  if (!normalized) {
    return null;
  }

  if (normalized.startsWith('magnet:?')) {
    return 'magnet';
  }

  try {
    const parsedUrl = new URL(normalized);

    if (parsedUrl.protocol === 'magnet:') {
      return 'magnet';
    }

    if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
      return 'http';
    }
  } catch {
    return null;
  }

  return null;
};

const normalizeRequestedType = (type) => {
  if (typeof type !== 'string' || !type.trim()) {
    return null;
  }

  const normalized = type.trim().toLowerCase();

  if (normalized === 'http' || normalized === 'torrent') {
    return normalized;
  }

  return null;
};

const toStremioCompatibilityScore = (stream) => {
  const url = String(stream.url || '').toLowerCase();
  const title = `${String(stream.name || '')} ${String(stream.title || '')}`.toLowerCase();
  let score = 0;

  if (stream.magnet || stream.torrent) {
    return 20 + score;
  }

  if (url.includes('.mp4')) {
    score += 120;
  } else if (url.includes('.m3u8')) {
    score += 100;
  } else if (url.includes('.webm')) {
    score += 70;
  } else if (url.includes('.mkv')) {
    score += 40;
  } else {
    score += 50;
  }

  const qualityMatch = String(stream.quality || '').match(/(\d{3,4})/);

  if (qualityMatch?.[1]) {
    const quality = Number.parseInt(qualityMatch[1], 10);
    score += Math.min(quality, 1080);
  }

  if (/\b(hevc|x265|10bit|hdr|dolby vision|dovi|remux|untouch)\b/u.test(title)) {
    score -= 400;
  }

  if (/\b(x264|h264|aac)\b/u.test(title)) {
    score += 80;
  }

  if (title.includes('auto')) {
    score -= 40;
  }

  return score;
};

const getStreamFormatBadge = (stream) => {
  if (stream.magnet || stream.torrent) {
    return '[TORRENT]';
  }

  const url = String(stream.url || '').toLowerCase();
  const text = `${String(stream.name || '')} ${String(stream.title || '')}`.toLowerCase();
  const parts = [];

  if (url.includes('.mp4')) {
    parts.push('MP4');
  } else if (url.includes('.m3u8')) {
    parts.push('HLS');
  } else if (url.includes('.mkv')) {
    parts.push('MKV');
  } else if (url.includes('.webm')) {
    parts.push('WEBM');
  } else {
    parts.push('HTTP');
  }

  if (/\b(hevc|x265)\b/u.test(text)) {
    parts.push('HEVC');
  } else if (/\b(h264|x264)\b/u.test(text)) {
    parts.push('H264');
  }

  if (/\b10bit\b/u.test(text)) {
    parts.push('10BIT');
  }

  if (/\b(hdr|dolby vision|dovi)\b/u.test(text)) {
    parts.push('HDR');
  }

  return `[${parts.join('/')}]`;
};

const toTitleCaseLabel = (providerId) =>
  String(providerId || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());

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

const DEFAULT_STREAM_OPTIONS = Object.freeze({
  webReadyOnly: false,
  hideHeavyFormats: false,
  maxSizeGb: 0,
  blockHosts: Object.freeze([]),
  preferredAudioLanguage: null,
  dedupeMode: 'off',
  preferHdr: false,
  preferH264: false,
  preferSmallerFiles: false,
  preferDirectHosts: false
});
const HUBCLOUD_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const HUBCLOUD_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

const normalizeQualityKey = (quality) => {
  const normalized = String(quality || '').trim().toLowerCase();

  if (!normalized) {
    return 'unknown';
  }

  if (normalized.includes('2160') || normalized === '4k') {
    return '2160p';
  }

  if (normalized.includes('1440')) {
    return '1440p';
  }

  if (normalized.includes('1080')) {
    return '1080p';
  }

  if (normalized.includes('720')) {
    return '720p';
  }

  if (normalized.includes('480') || normalized.includes('sd') || normalized.includes('low hd')) {
    return '480p';
  }

  if (normalized.includes('360')) {
    return '360p';
  }

  if (normalized.includes('auto') || normalized.includes('adaptive') || normalized.includes('mid hd')) {
    return 'auto';
  }

  return 'unknown';
};

const getQualityPriorityScore = (stream, qualityPriority) => {
  const normalizedQuality = normalizeQualityKey(stream.quality);
  const index = qualityPriority.indexOf(normalizedQuality);

  if (index === -1) {
    return 0;
  }

  return (qualityPriority.length - index) * 10000;
};

const hasForwardHeaders = (headers) =>
  Boolean(headers && typeof headers === 'object' && Object.keys(headers).length > 0);

const isWebReadyHttpStream = (stream) =>
  stream.transport === 'http' &&
  Boolean(stream.url) &&
  isPlainMp4Url(stream.url) &&
  !hasForwardHeaders(stream.headers);

const hasHeavyFormatTraits = (stream) => {
  const text = `${String(stream.name || '')} ${String(stream.title || '')}`.toLowerCase();
  return /\b(hevc|x265|10bit|hdr|hdr10|hdr10\+|dolby vision|dovi|remux|untouch)\b/u.test(text);
};

const parseSizeBytes = (value) => {
  const match = String(value || '').match(/(\d+(?:\.\d+)?)\s*(tb|gb|mb|kb|b)\b/i);

  if (!match) {
    return null;
  }

  const amount = Number.parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = {
    b: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
    tb: 1024 * 1024 * 1024 * 1024
  }[unit];

  if (!Number.isFinite(amount) || !multiplier) {
    return null;
  }

  return Math.round(amount * multiplier);
};

const getStreamSizeBytes = (stream) => {
  const explicitSize = parseSizeBytes(stream.size);

  if (explicitSize) {
    return explicitSize;
  }

  return parseSizeBytes(`${String(stream.name || '')}\n${String(stream.title || '')}`);
};

const getStreamHostname = (stream) => {
  try {
    return new URL(String(stream.url || '').trim()).hostname.toLowerCase().replace(/^www\./u, '');
  } catch {
    return '';
  }
};

const toDiagnosticStreamExample = (stream) => ({
  name: stream.name || 'Untitled stream',
  quality: stream.quality || 'Unknown',
  host: getStreamHostname(stream) || 'Unknown host',
  size: stream.size || 'Unknown size'
});

const normalizeDedupeMode = (value) => {
  const normalized = String(value || '').trim().toLowerCase();

  if (normalized === 'smart' || normalized === 'filename' || normalized === 'host-quality') {
    return normalized;
  }

  return 'off';
};

const normalizeFilenameKey = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/u, '')
    .replace(/\[[^\]]+\]|\([^)]+\)/gu, ' ')
    .replace(/[_+.]+/g, ' ')
    .replace(/\b(2160p|1440p|1080p|720p|480p|360p|hevc|x265|x264|h264|hdr|hdr10\+?|dovi|dv|10bit|aac|atmos|web[- ]dl|webrip|bluray|multi)\b/gu, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const getExactUrlKey = (stream) => {
  if (!stream.url) {
    return '';
  }

  try {
    const parsedUrl = new URL(String(stream.url).trim());
    parsedUrl.hash = '';
    return `${parsedUrl.hostname.toLowerCase()}${parsedUrl.pathname}`;
  } catch {
    return String(stream.url || '').trim().toLowerCase();
  }
};

const getStreamDedupeKey = (stream, dedupeMode) => {
  if (stream.infoHash) {
    return `infohash:${String(stream.infoHash).toLowerCase()}`;
  }

  const qualityKey = normalizeQualityKey(stream.quality);
  const hostKey = getStreamHostname(stream);
  const filenameKey = normalizeFilenameKey(stream.filename || extractFilenameFromUrl(stream.url) || '');
  const sizeBytes = getStreamSizeBytes(stream);

  if (dedupeMode === 'filename') {
    return filenameKey ? `filename:${filenameKey}|${qualityKey}` : '';
  }

  if (dedupeMode === 'host-quality') {
    return hostKey ? `host-quality:${hostKey}|${qualityKey}` : '';
  }

  if (dedupeMode === 'smart') {
    if (filenameKey) {
      return `smart-filename:${filenameKey}|${qualityKey}`;
    }

    if (hostKey && sizeBytes) {
      return `smart-host-size:${hostKey}|${qualityKey}|${sizeBytes}`;
    }

    const exactUrlKey = getExactUrlKey(stream);

    if (exactUrlKey) {
      return `smart-url:${exactUrlKey}|${qualityKey}`;
    }
  }

  return '';
};

const applyConfiguredDedupe = (streams, streamOptions) => {
  const dedupeMode = normalizeDedupeMode(streamOptions.dedupeMode);

  if (dedupeMode === 'off' || streams.length <= 1) {
    return {
      streams,
      dedupeMode,
      removedCount: 0,
      examples: []
    };
  }

  const dedupedStreams = [];
  const seenKeys = new Set();
  let removedCount = 0;
  const examples = [];

  for (const stream of streams) {
    const dedupeKey = getStreamDedupeKey(stream, dedupeMode);

    if (!dedupeKey) {
      dedupedStreams.push(stream);
      continue;
    }

    if (seenKeys.has(dedupeKey)) {
      removedCount += 1;

       if (examples.length < 3) {
        examples.push(toDiagnosticStreamExample(stream));
      }
      continue;
    }

    seenKeys.add(dedupeKey);
    dedupedStreams.push(stream);
  }

  return {
    streams: dedupedStreams,
    dedupeMode,
    removedCount,
    examples
  };
};

const filterConfiguredStreamsDetailed = (streams, streamOptions) => {
  const filteredStreams = [];
  const diagnostics = {
    inputTotal: streams.length,
    keptTotal: 0,
    filteredTotal: 0,
    dedupedTotal: 0,
    dedupeMode: normalizeDedupeMode(streamOptions.dedupeMode),
    reasons: {
      nonHttp: 0,
      notWebReady: 0,
      heavyFormat: 0,
      tooLarge: 0,
      blockedHost: 0,
      languageMismatch: 0,
      duplicate: 0
    },
    examples: {
      nonHttp: [],
      notWebReady: [],
      heavyFormat: [],
      tooLarge: [],
      blockedHost: [],
      languageMismatch: [],
      duplicate: []
    }
  };
  const maxBytes = Number(streamOptions.maxSizeGb) > 0
    ? Number(streamOptions.maxSizeGb) * 1024 * 1024 * 1024
    : 0;
  const blockedHosts = Array.isArray(streamOptions.blockHosts)
    ? streamOptions.blockHosts.filter(Boolean)
    : [];
  const preferredAudioLanguage = normalizeAudioLanguageKey(streamOptions.preferredAudioLanguage);

  for (const stream of streams) {
    let reason = null;

    if (stream.transport !== 'http') {
      reason = 'nonHttp';
    } else if (streamOptions.webReadyOnly && !isWebReadyHttpStream(stream)) {
      reason = 'notWebReady';
    } else if (streamOptions.hideHeavyFormats && hasHeavyFormatTraits(stream)) {
      reason = 'heavyFormat';
    } else if (maxBytes > 0) {
      const sizeBytes = getStreamSizeBytes(stream);

      if (sizeBytes && sizeBytes > maxBytes) {
        reason = 'tooLarge';
      }
    }

    if (!reason && blockedHosts.length > 0) {
      const hostname = getStreamHostname(stream);

      if (hostname && blockedHosts.some((blockedHost) => hostname.includes(blockedHost))) {
        reason = 'blockedHost';
      }
    }

    if (!reason && preferredAudioLanguage) {
      const languages = getStreamLanguages(stream);

      if (languages.length > 0 && !languages.includes(preferredAudioLanguage)) {
        reason = 'languageMismatch';
      }
    }

    if (reason) {
      diagnostics.filteredTotal += 1;
      diagnostics.reasons[reason] += 1;
      if (diagnostics.examples[reason].length < 3) {
        diagnostics.examples[reason].push(toDiagnosticStreamExample(stream));
      }
      continue;
    }

    filteredStreams.push(stream);
  }

  diagnostics.keptTotal = filteredStreams.length;

  return {
    streams: filteredStreams,
    diagnostics
  };
};

const filterConfiguredStreams = (streams, streamOptions) =>
  filterConfiguredStreamsDetailed(streams, streamOptions).streams;

const summarizeStreamOptions = (streamOptions) => {
  const parts = [];

  if (streamOptions.webReadyOnly) {
    parts.push('Web-ready only');
  }

  if (streamOptions.hideHeavyFormats) {
    parts.push('Hide HEVC / HDR / 10-bit');
  }

  if (Number(streamOptions.maxSizeGb) > 0) {
    parts.push(`Max ${Number(streamOptions.maxSizeGb)} GB`);
  }

  if (Array.isArray(streamOptions.blockHosts) && streamOptions.blockHosts.length > 0) {
    parts.push(`Block hosts: ${streamOptions.blockHosts.join(', ')}`);
  }

  if (streamOptions.preferredAudioLanguage) {
    parts.push(`Audio: ${streamOptions.preferredAudioLanguage} + Unknown`);
  }

  if (normalizeDedupeMode(streamOptions.dedupeMode) !== 'off') {
    const dedupeLabels = {
      smart: 'Smart dedupe',
      filename: 'Dedupe by filename',
      'host-quality': 'Dedupe by host + quality'
    };
    parts.push(dedupeLabels[normalizeDedupeMode(streamOptions.dedupeMode)] || 'Dedupe on');
  }

  if (streamOptions.preferHdr) {
    parts.push('Prefer HDR');
  }

  if (streamOptions.preferH264) {
    parts.push('Prefer H.264');
  }

  if (streamOptions.preferSmallerFiles) {
    parts.push('Prefer smaller files');
  }

  if (streamOptions.preferDirectHosts) {
    parts.push('Prefer direct hosts');
  }

  return parts.length > 0 ? parts.join(', ') : 'Default HTTP playback';
};

const getDeliveryPriorityScore = (stream) => {
  if (stream.transport === 'http') {
    return hasForwardHeaders(stream.headers) ? -5000 : 5000;
  }

  if (stream.transport === 'torrent') {
    return -12000;
  }

  return 0;
};

const getProviderPriorityScore = (stream, providerOrder) => {
  if (!Array.isArray(providerOrder) || providerOrder.length === 0) {
    return 0;
  }

  const providerId = String(stream.provider || '').trim().toLowerCase();
  const index = providerOrder.indexOf(providerId);

  if (index === -1) {
    return 0;
  }

  return (providerOrder.length - index) * 1500;
};

const fetchTextWithTimeout = async (url, options = {}, timeout = 8000) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.text();
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
};

const stripHtml = (html) =>
  String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#8211;|&#8212;/gi, '-')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/\s+/g, ' ')
    .trim();

const extractHubCloudAnchorCandidates = (html) => {
  const candidates = [];
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorPattern.exec(html)) !== null) {
    const href = String(match[1] || '').replace(/&amp;/g, '&').trim();
    const text = stripHtml(match[2]);

    if (!href || !/^https?:\/\//i.test(href)) {
      continue;
    }

    candidates.push({ href, text });
  }

  return candidates;
};

const getHubCloudCandidateScore = ({ href, text }) => {
  const normalizedHref = href.toLowerCase();
  const normalizedText = text.toLowerCase();
  let score = 0;

  if (normalizedText.includes('pdl') || normalizedHref.includes('workers.dev')) {
    score += 500;
  }

  if (normalizedText.includes('pixel') || normalizedText.includes('10gbps') || normalizedHref.includes('pixel.')) {
    score += 400;
  }

  if (normalizedText.includes('fslv2')) {
    score += 250;
  } else if (normalizedText.includes('fsl')) {
    score += 220;
  }

  if (normalizedHref.includes('hubcloud') || normalizedHref.includes('gamerxyt.com')) {
    score -= 300;
  }

  return score;
};

const classifyHubCloudCandidate = ({ href, text }) => {
  const normalizedHref = String(href || '').toLowerCase();
  const normalizedText = String(text || '').toLowerCase();

  if (normalizedText.includes('fslv2')) {
    return 'FSLv2';
  }

  if (normalizedText.includes('fsl')) {
    return 'FSL';
  }

  if (normalizedText.includes('pixelserver') || normalizedText.includes('pixel') || normalizedHref.includes('pixeldrain')) {
    return 'PixelServer';
  }

  if (normalizedText.includes('pdl') || normalizedHref.includes('workers.dev')) {
    return 'PDL';
  }

  return 'Download';
};

const parseHubCloudTitle = (html) => {
  const explicitTitleMatch = html.match(/<div class="card-header[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  if (explicitTitleMatch?.[1]) {
    return stripHtml(explicitTitleMatch[1]);
  }

  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  return titleMatch?.[1] ? stripHtml(titleMatch[1]) : null;
};

const parseHubCloudSize = (html) => {
  const sizeMatch = html.match(/id=["']size["'][^>]*>([\s\S]*?)</i);
  return sizeMatch?.[1] ? stripHtml(sizeMatch[1]) : null;
};

const isHubCloudUrl = (streamUrl) => {
  try {
    return new URL(String(streamUrl || '').trim()).hostname.toLowerCase().includes('hubcloud');
  } catch {
    return false;
  }
};

const getCompactTags = (stream) => {
  const text = `${String(stream.name || '')} ${String(stream.title || '')}`.toLowerCase();
  const tags = [];

  if (text.includes('hdr10+') || text.includes('hdr10')) {
    tags.push('HDR10+');
  } else if (text.includes('hdr')) {
    tags.push('HDR');
  }

  if (text.includes('dolby vision') || text.includes('dovi')) {
    tags.push('Dolby Vision');
  }

  if (text.includes('web-dl') || text.includes('webrip')) {
    tags.push('WEB-DL');
  } else if (text.includes('bluray') || text.includes('blu-ray')) {
    tags.push('BluRay');
  }

  if (text.includes('hevc') || text.includes('x265')) {
    tags.push('hevc');
  } else if (text.includes('x264') || text.includes('h264')) {
    tags.push('h264');
  }

  if (text.includes('atmos')) {
    tags.push('Atmos');
  } else if (text.includes('aac')) {
    tags.push('AAC');
  }

  return tags;
};

const AUDIO_LANGUAGE_PATTERNS = Object.freeze([
  ['Hindi', /\bhindi\b/u],
  ['English', /\benglish\b/u],
  ['Tamil', /\btamil\b/u],
  ['Telugu', /\btelugu\b/u],
  ['Malayalam', /\bmalayalam\b/u],
  ['Kannada', /\bkannada\b/u],
  ['French', /\bfrench\b/u],
  ['German', /\bgerman\b/u],
  ['Spanish', /\bspanish\b/u],
  ['Portuguese', /\bportuguese\b/u],
  ['Japanese', /\bjapanese\b/u],
  ['Korean', /\bkorean\b/u]
]);

const normalizeAudioLanguageKey = (value) => {
  const normalized = String(value || '').trim().toLowerCase();

  if (!normalized || normalized === 'any' || normalized === 'unknown') {
    return null;
  }

  const matched = AUDIO_LANGUAGE_PATTERNS.find(([label]) => label.toLowerCase() === normalized);
  return matched ? matched[0] : null;
};

const getStreamLanguages = (stream) => {
  const text = `${String(stream.name || '')} ${String(stream.title || '')}`.toLowerCase();
  const languages = [];

  for (const [label, pattern] of AUDIO_LANGUAGE_PATTERNS) {
    if (pattern.test(text)) {
      languages.push(label);
    }
  }

  return [...new Set(languages)];
};

const getLanguageLabel = (stream) => {
  const languages = getStreamLanguages(stream);

  if (languages.length === 0) {
    return 'Unknown';
  }

  return [...new Set(languages)].join(' + ');
};

const getSourceLabel = (stream) => {
  if (stream.sourceSite) {
    return stream.sourceSite;
  }

  return toTitleCaseLabel(stream.provider || 'default');
};

const getPreferredAudioLanguageScore = (stream, streamOptions) => {
  const preferredAudioLanguage = normalizeAudioLanguageKey(streamOptions.preferredAudioLanguage);

  if (!preferredAudioLanguage) {
    return 0;
  }

  const languages = getStreamLanguages(stream);

  if (languages.includes(preferredAudioLanguage)) {
    return 7000;
  }

  if (languages.length === 0) {
    return 1500;
  }

  return 0;
};

const getStreamPreferenceScore = (stream, streamOptions) => {
  const text = `${String(stream.name || '')} ${String(stream.title || '')}`.toLowerCase();
  let score = 0;

  if (streamOptions.preferHdr) {
    if (/\b(hdr|hdr10|hdr10\+|dolby vision|dovi)\b/u.test(text)) {
      score += 4500;
    }
  }

  if (streamOptions.preferH264) {
    if (/\b(h264|x264)\b/u.test(text)) {
      score += 4200;
    } else if (/\b(hevc|x265)\b/u.test(text)) {
      score -= 500;
    }
  }

  if (streamOptions.preferSmallerFiles) {
    const sizeBytes = getStreamSizeBytes(stream);

    if (sizeBytes) {
      const sizeGb = sizeBytes / (1024 * 1024 * 1024);
      score += Math.max(0, 4000 - Math.round(sizeGb * 350));
    }
  }

  if (streamOptions.preferDirectHosts) {
    if (stream.transport === 'http' && !hasForwardHeaders(stream.headers)) {
      score += 3800;
    }
  }

  return score;
};

const formatStremioCardTitle = (stream) => {
  const tags = getCompactTags(stream);
  const topLine = [
    `🎬 ${stream.quality || 'Unknown'}`,
    ...tags
  ].join(' ✦ ');

  const lines = [
    topLine,
    `💾 ${stream.size || 'Unknown size'}`,
    `🌐 ${getLanguageLabel(stream)}`,
    `🔗 ${getSourceLabel(stream)}`,
    `${String(stream.quality || 'Unknown').toUpperCase()}`
  ];

  return lines.join('\n');
};

const extractFilenameFromUrl = (streamUrl) => {
  try {
    const parsedUrl = new URL(String(streamUrl || '').trim());
    const filename = decodeURIComponent(parsedUrl.pathname.split('/').pop() || '').trim();
    return filename || undefined;
  } catch {
    return undefined;
  }
};

const isPlainMp4Url = (streamUrl) => {
  try {
    const parsedUrl = new URL(String(streamUrl || '').trim());
    return parsedUrl.protocol === 'https:' && parsedUrl.pathname.toLowerCase().endsWith('.mp4');
  } catch {
    return false;
  }
};

const getTorrentSources = (magnet) => {
  try {
    const parsedUrl = new URL(String(magnet || '').trim());
    const trackers = parsedUrl.searchParams.getAll('tr')
      .map((trackerUrl) => trackerUrl.trim())
      .filter((trackerUrl) => /^https?:\/\/|^udp:\/\//u.test(trackerUrl))
      .map((trackerUrl) => `tracker:${trackerUrl}`);

    return trackers.filter((source, index) => trackers.indexOf(source) === index);
  } catch {
    return [];
  }
};

const toStremioStreamObject = (stream, parsedRequest) => {
  const base = {
    name: stream.provider
      ? `NebulaStreams | ${toTitleCaseLabel(stream.provider)}`
      : 'NebulaStreams',
    title: formatStremioCardTitle(stream),
    behaviorHints: {
      bingeGroup: parsedRequest.mediaType === 'series'
        ? `${parsedRequest.imdbId}:${stream.provider || 'default'}:${stream.quality || 'unknown'}`
        : undefined
    }
  };

  if (stream.transport === 'torrent' && stream.magnet) {
    const infoHash = extractInfoHash(stream.magnet);

    if (!infoHash) {
      return null;
    }

    const sources = getTorrentSources(stream.magnet);

    return {
      ...base,
      infoHash,
      ...(sources.length > 0 ? { sources } : {})
    };
  }

  if (!stream.url) {
    return null;
  }

  const requestHeaders = hasForwardHeaders(stream.headers) ? { ...stream.headers } : null;
  const isWebReady = isPlainMp4Url(stream.url) && !requestHeaders;

  return {
    ...base,
    url: stream.url,
    ...(extractFilenameFromUrl(stream.url) ? { filename: extractFilenameFromUrl(stream.url) } : {}),
    behaviorHints: {
      ...base.behaviorHints,
      notWebReady: !isWebReady,
      ...(requestHeaders ? {
        proxyHeaders: {
          request: requestHeaders
        }
      } : {})
    }
  };
};

export class HttpError extends Error {
  constructor(statusCode, message, details = undefined) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

export const createHttpError = (statusCode, message, details) =>
  new HttpError(statusCode, message, details);

export const parseRangeHeader = (rangeHeader, totalSize) => {
  if (!rangeHeader) {
    return {
      start: 0,
      end: totalSize - 1,
      contentLength: totalSize,
      statusCode: 200,
      contentRange: null
    };
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());

  if (!match) {
    throw createHttpError(416, 'Only single byte ranges are supported');
  }

  const [, rawStart, rawEnd] = match;

  if (rawStart === '' && rawEnd === '') {
    throw createHttpError(416, 'Invalid range header');
  }

  let start = rawStart === '' ? null : Number.parseInt(rawStart, 10);
  let end = rawEnd === '' ? null : Number.parseInt(rawEnd, 10);

  if ((start !== null && Number.isNaN(start)) || (end !== null && Number.isNaN(end))) {
    throw createHttpError(416, 'Invalid range header');
  }

  if (start === null) {
    const suffixLength = end;

    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      throw createHttpError(416, 'Invalid suffix range');
    }

    start = Math.max(totalSize - suffixLength, 0);
    end = totalSize - 1;
  } else {
    end = end ?? totalSize - 1;
  }

  if (start < 0 || end < 0 || start > end || start >= totalSize) {
    throw createHttpError(416, 'Requested range is not satisfiable');
  }

  end = Math.min(end, totalSize - 1);

  return {
    start,
    end,
    contentLength: end - start + 1,
    statusCode: 206,
    contentRange: `bytes ${start}-${end}/${totalSize}`
  };
};

export class StreamManager {
  constructor({ torrentEngine, httpProxy, cacheManager, sourceRegistry, providerService, imdbResolver }) {
    this.torrentEngine = torrentEngine;
    this.httpProxy = httpProxy;
    this.cacheManager = cacheManager;
    this.sourceRegistry = sourceRegistry;
    this.providerService = providerService;
    this.imdbResolver = imdbResolver;
    this.activeStreams = 0;
    this.stremioResultCache = new Map();
    this.stremioResultCacheDir = cacheConfig.STREMIO_RESULT_CACHE_DIR;
    this.stremioResultCacheDirReady = null;
    this.hubCloudCache = new Map();
    this.hubCloudInFlight = new Map();
  }

  async ensureStremioResultCacheDir() {
    if (!this.stremioResultCacheDirReady) {
      this.stremioResultCacheDirReady = mkdir(this.stremioResultCacheDir, { recursive: true });
    }

    await this.stremioResultCacheDirReady;
  }

  buildStremioResultCacheKey({ tmdbId, mediaType, season, episode, providers, qualityPriority, streamOptions }) {
    return JSON.stringify({
      version: 1,
      tmdbId,
      mediaType,
      season: season ?? null,
      episode: episode ?? null,
      providers: providers ?? [],
      qualityPriority,
      streamOptions: streamOptions ?? DEFAULT_STREAM_OPTIONS
    });
  }

  getStremioResultCachePath(cacheKey) {
    const fileName = `${createHash('sha1').update(cacheKey).digest('hex')}.json`;
    return path.join(this.stremioResultCacheDir, fileName);
  }

  async getCachedStremioStreams(cacheKey) {
    const cached = this.stremioResultCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.streams.map((stream) => ({ ...stream }));
    }

    if (cached) {
      this.stremioResultCache.delete(cacheKey);
    }

    await this.ensureStremioResultCacheDir();

    try {
      const payload = JSON.parse(await readFile(this.getStremioResultCachePath(cacheKey), 'utf8'));

      if (!payload || payload.expiresAt <= Date.now() || !Array.isArray(payload.streams)) {
        await rm(this.getStremioResultCachePath(cacheKey), { force: true });
        return null;
      }

      this.stremioResultCache.set(cacheKey, {
        expiresAt: payload.expiresAt,
        streams: payload.streams.map((stream) => ({ ...stream }))
      });

      return payload.streams.map((stream) => ({ ...stream }));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn('stremio result cache read failed', {
          error
        });
      }

      return null;
    }
  }

  async setCachedStremioStreams(cacheKey, streams) {
    const entry = {
      expiresAt: Date.now() + (config.STREMIO_RESULT_CACHE_TTL_SECONDS * 1000),
      streams: streams.map((stream) => ({ ...stream }))
    };

    this.stremioResultCache.set(cacheKey, entry);
    await this.ensureStremioResultCacheDir();

    try {
      await writeFile(this.getStremioResultCachePath(cacheKey), JSON.stringify(entry));
    } catch (error) {
      logger.warn('stremio result cache write failed', {
        error
      });
    }
  }

  getRequestedProviders(req) {
    const rawConfig = typeof req.params?.providerConfig === 'string'
      ? req.params.providerConfig
      : typeof req.query?.providers === 'string'
        ? req.query.providers
        : '';
    const decoded = rawConfig ? decodeURIComponent(rawConfig) : '';

    if (!decoded || decoded === 'all') {
      return [];
    }

    const requestedProviders = decoded
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    return this.providerService.normalizeProviders(requestedProviders);
  }

  getRequestedQualityPriority(req) {
    const rawConfig = typeof req.params?.qualityConfig === 'string'
      ? req.params.qualityConfig
      : typeof req.query?.qualities === 'string'
        ? req.query.qualities
        : '';
    const decoded = rawConfig ? decodeURIComponent(rawConfig) : '';

    if (!decoded || decoded === 'default') {
      return [...DEFAULT_QUALITY_PRIORITY];
    }

    const requestedQualities = decoded
      .split(',')
      .map((value) => normalizeQualityKey(value))
      .filter(Boolean);
    const uniqueQualities = requestedQualities.filter((quality, index) =>
      requestedQualities.indexOf(quality) === index
    );

    if (uniqueQualities.length === 0) {
      return [...DEFAULT_QUALITY_PRIORITY];
    }

    for (const quality of DEFAULT_QUALITY_PRIORITY) {
      if (!uniqueQualities.includes(quality)) {
        uniqueQualities.push(quality);
      }
    }

    return uniqueQualities;
  }

  getRequestedStreamOptions(req) {
    const rawConfig = typeof req.params?.optionConfig === 'string'
      ? req.params.optionConfig
      : typeof req.query?.options === 'string'
        ? req.query.options
        : '';
    const decoded = rawConfig ? decodeURIComponent(rawConfig) : '';

    if (!decoded || decoded === 'default') {
      return { ...DEFAULT_STREAM_OPTIONS };
    }

    const tokens = decoded
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);

    let maxSizeGb = 0;
    let blockHosts = [];
    let preferredAudioLanguage = null;
    let dedupeMode = 'off';

    for (const token of tokens) {
      if (token.startsWith('max-size-gb=')) {
        const parsed = Number.parseFloat(token.slice('max-size-gb='.length));

        if (Number.isFinite(parsed) && parsed > 0) {
          maxSizeGb = parsed;
        }
      }

      if (token.startsWith('block-hosts=')) {
        blockHosts = token
          .slice('block-hosts='.length)
          .split('|')
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean)
          .filter((value, index, values) => values.indexOf(value) === index);
      }

      if (token.startsWith('preferred-audio=')) {
        preferredAudioLanguage = normalizeAudioLanguageKey(token.slice('preferred-audio='.length));
      }

      if (token.startsWith('dedupe=')) {
        dedupeMode = normalizeDedupeMode(token.slice('dedupe='.length));
      }
    }

    return {
      webReadyOnly: tokens.includes('web-ready-only'),
      hideHeavyFormats: tokens.includes('hide-heavy-formats'),
      maxSizeGb,
      blockHosts,
      preferredAudioLanguage,
      dedupeMode,
      preferHdr: tokens.includes('prefer-hdr'),
      preferH264: tokens.includes('prefer-h264'),
      preferSmallerFiles: tokens.includes('prefer-smaller-files'),
      preferDirectHosts: tokens.includes('prefer-direct-hosts')
    };
  }

  getAddonPresentation(req) {
    const providers = this.getRequestedProviders(req);
    const qualityPriority = this.getRequestedQualityPriority(req);
    const streamOptions = this.getRequestedStreamOptions(req);
    const hasDefaultQualityPriority = qualityPriority.join(',') === DEFAULT_QUALITY_PRIORITY.join(',');
    const hasDefaultStreamOptions = JSON.stringify(streamOptions) === JSON.stringify(DEFAULT_STREAM_OPTIONS);

    if (providers.length === 0 && hasDefaultQualityPriority && hasDefaultStreamOptions) {
      return {
        providers,
        qualityPriority,
        streamOptions,
        addonId: config.STREMIO_ADDON_ID,
        addonName: config.STREMIO_ADDON_NAME,
        configurable: true,
        description: 'Fast multi-provider HTTP stream addon for movies and series'
      };
    }

    const providerHash = createHash('sha1')
      .update(`${providers.join(',')}|${qualityPriority.join(',')}|${JSON.stringify(streamOptions)}`)
      .digest('hex')
      .slice(0, 10);
    const providerLabel = providers.length > 0
      ? providers.map((provider) => toTitleCaseLabel(provider)).join(', ')
      : 'All Providers';

    return {
      providers,
      qualityPriority,
      streamOptions,
      addonId: `${config.STREMIO_ADDON_ID}.${providerHash}`,
      addonName: `${config.STREMIO_ADDON_NAME} [${providerLabel}]`,
      configurable: true,
      description: `Filtered to: ${providerLabel}. Quality priority: ${qualityPriority.join(' > ')}. Playback: ${summarizeStreamOptions(streamOptions)}`
    };
  }

  async handleStremioManifest(req, res) {
    const baseUrl = config.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const addonPresentation = this.getAddonPresentation(req);

    res.json({
      id: addonPresentation.addonId,
      version: '1.0.0',
      name: addonPresentation.addonName,
      description: addonPresentation.description,
      resources: [{
        name: 'stream',
        types: ['movie', 'series'],
        idPrefixes: ['tt']
      }],
      types: ['movie', 'series'],
      idPrefixes: ['tt'],
      catalogs: [],
      behaviorHints: {
        configurable: addonPresentation.configurable
      },
      logo: `${baseUrl}/assets/nebulastreams-icon.jpg`,
      stremioAddonsConfig: {
        issuer: 'https://stremio-addons.net',
        signature: 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..c1dKT48ayjjpai4JwQCcTA.cTsGooecPtjL0uCwd_o8UuHCo--DfHlIfkqcpk5Pk5UidakL038sCsT2RMB6AuUyBZOVlVP2LKHbygHwNcYtcADvRZIK53YGr-SL2V9L8YH6SFgUwJC5eBE8lOlUWKio.ygBtjPAXg3ikys04cQarXQ'
      }
    });
  }

  async handleStremioStreams(req, res, next) {
    try {
      const parsed = this.parseStremioStreamRequest(req.params.type, req.params.id);
      let tmdbId;

      try {
        tmdbId = await this.imdbResolver.resolve({
          imdbId: parsed.imdbId,
          mediaType: parsed.mediaType
        });
      } catch (error) {
        logger.warn('stremio imdb resolution failed', {
          imdbId: parsed.imdbId,
          mediaType: parsed.mediaType,
          error
        });
        res.json({ streams: [] });
        return;
      }

      if (!tmdbId) {
        res.json({ streams: [] });
        return;
      }

      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const requestedProviders = this.getRequestedProviders(req);
      const qualityPriority = this.getRequestedQualityPriority(req);
      const streamOptions = this.getRequestedStreamOptions(req);
      const resultCacheKey = this.buildStremioResultCacheKey({
        tmdbId,
        mediaType: parsed.mediaType,
        season: parsed.season,
        episode: parsed.episode,
        providers: requestedProviders,
        qualityPriority,
        streamOptions
      });
      const cachedStreams = await this.getCachedStremioStreams(resultCacheKey);

      if (cachedStreams) {
        res.json({
          streams: cachedStreams
        });
        return;
      }

      const result = await this.providerService.getFastStreams({
        providers: requestedProviders.length > 0 ? requestedProviders : null,
        tmdbId,
        mediaType: parsed.mediaType === 'series' ? 'tv' : 'movie',
        season: parsed.season,
        episode: parsed.episode
      });

      if (result.streams.length === 0) {
        await this.setCachedStremioStreams(resultCacheKey, []);
        res.json({ streams: [] });
        return;
      }

      const normalizedStreams = await this.normalizeProviderStreams(baseUrl, result.streams);
      const { streams: configuredStreams } = filterConfiguredStreamsDetailed(normalizedStreams, streamOptions);

      if (configuredStreams.length === 0) {
        await this.setCachedStremioStreams(resultCacheKey, []);
        res.json({ streams: [] });
        return;
      }

      configuredStreams.sort((left, right) =>
        (getQualityPriorityScore(right, qualityPriority) + getPreferredAudioLanguageScore(right, streamOptions) + getStreamPreferenceScore(right, streamOptions) + getProviderPriorityScore(right, result.providers) + getDeliveryPriorityScore(right) + toStremioCompatibilityScore(right)) -
        (getQualityPriorityScore(left, qualityPriority) + getPreferredAudioLanguageScore(left, streamOptions) + getStreamPreferenceScore(left, streamOptions) + getProviderPriorityScore(left, result.providers) + getDeliveryPriorityScore(left) + toStremioCompatibilityScore(left))
      );
      const dedupedStreams = applyConfiguredDedupe(configuredStreams, streamOptions).streams;
      const stremioStreams = dedupedStreams
        .map((stream) => toStremioStreamObject(stream, parsed))
        .filter(Boolean);

      await this.setCachedStremioStreams(resultCacheKey, stremioStreams);

      res.json({
        streams: stremioStreams
      });
    } catch (error) {
      next(error);
    }
  }

  async handleTorrentStream(req, res, next) {
    try {
      const descriptor = await this.handleStreamRequest({
        source: req.query.magnet,
        fileIndex: req.query.fileIndex,
        fileName: req.query.fileName,
        rangeHeader: req.headers.range
      });

      await this.sendStream(res, descriptor);
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }

      next(error);
    }
  }

  async handleHttpStream(req, res, next) {
    try {
      const descriptor = await this.handleStreamRequest({
        source: req.query.url,
        rangeHeader: req.headers.range
      });

      await this.sendStream(res, descriptor);
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }

      next(error);
    }
  }

  async handleAddSource(req, res, next) {
    try {
      const streamUrl = await this.createRegisteredStreamUrl(`${req.protocol}://${req.get('host')}`, {
        type: req.body?.type,
        source: req.body?.source,
        headers: req.body?.headers,
        metadata: req.body?.metadata
      });

      res.json({
        streamUrl: streamUrl.toString(),
        sourceId: streamUrl.searchParams.get('sourceId')
      });
    } catch (error) {
      logger.error('add-source failed', {
        error
      });
      next(error);
    }
  }

  async handleProviderStreams(req, res, next) {
    try {
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const provider = req.params.provider;
      const streams = await this.providerService.getStreams({
        provider,
        tmdbId: req.query.tmdbId,
        mediaType: req.query.mediaType,
        season: req.query.season,
        episode: req.query.episode
      });

      if (streams.length === 0) {
        res.json({
          provider,
          count: 0,
          streams: []
        });
        return;
      }

      const normalizedStreams = await this.normalizeProviderStreams(baseUrl, streams, provider);

      res.json({
        provider,
        count: normalizedStreams.length,
        streams: normalizedStreams
      });
    } catch (error) {
      next(error);
    }
  }

  async handleAggregateProviderStreams(req, res, next) {
    try {
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const requestedProviders = typeof req.query.providers === 'string'
        ? req.query.providers.split(',').map((value) => value.trim()).filter(Boolean)
        : undefined;
      const result = await this.providerService.getAggregateStreams({
        providers: requestedProviders,
        tmdbId: req.query.tmdbId,
        mediaType: req.query.mediaType,
        season: req.query.season,
        episode: req.query.episode
      });

      if (result.streams.length === 0) {
        res.json({
          provider: null,
          count: 0,
          tried: result.tried,
          streams: []
        });
        return;
      }

      const normalizedStreams = await this.normalizeProviderStreams(baseUrl, result.streams);

      res.json({
        provider: null,
        count: normalizedStreams.length,
        tried: result.tried,
        streams: normalizedStreams
      });
    } catch (error) {
      next(error);
    }
  }

  async handleUnifiedStream(req, res, next) {
    try {
      const descriptor = await this.handleStreamRequest({
        sourceId: req.query.sourceId,
        type: req.query.type,
        source: req.query.source,
        rangeHeader: req.headers.range
      });

      await this.sendStream(res, descriptor);
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }

      next(error);
    }
  }

  async handleStremioPreview(req, res, next) {
    try {
      const parsed = this.parseStremioStreamRequest(req.params.type, req.params.id);
      let tmdbId;

      try {
        tmdbId = await this.imdbResolver.resolve({
          imdbId: parsed.imdbId,
          mediaType: parsed.mediaType
        });
      } catch (error) {
        logger.warn('stremio preview imdb resolution failed', {
          imdbId: parsed.imdbId,
          mediaType: parsed.mediaType,
          error
        });
        res.json({
          resolved: false,
          reason: 'imdb-resolution-failed'
        });
        return;
      }

      if (!tmdbId) {
        res.json({
          resolved: false,
          reason: 'tmdb-not-found'
        });
        return;
      }

      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const requestedProviders = this.getRequestedProviders(req);
      const qualityPriority = this.getRequestedQualityPriority(req);
      const streamOptions = this.getRequestedStreamOptions(req);
      const result = await this.providerService.getFastStreams({
        providers: requestedProviders.length > 0 ? requestedProviders : null,
        tmdbId,
        mediaType: parsed.mediaType === 'series' ? 'tv' : 'movie',
        season: parsed.season,
        episode: parsed.episode
      });
      const normalizedStreams = await this.normalizeProviderStreams(baseUrl, result.streams);
      const { streams: configuredStreams, diagnostics } = filterConfiguredStreamsDetailed(normalizedStreams, streamOptions);

      configuredStreams.sort((left, right) =>
        (getQualityPriorityScore(right, qualityPriority) + getPreferredAudioLanguageScore(right, streamOptions) + getStreamPreferenceScore(right, streamOptions) + getProviderPriorityScore(right, result.providers) + getDeliveryPriorityScore(right) + toStremioCompatibilityScore(right)) -
        (getQualityPriorityScore(left, qualityPriority) + getPreferredAudioLanguageScore(left, streamOptions) + getStreamPreferenceScore(left, streamOptions) + getProviderPriorityScore(left, result.providers) + getDeliveryPriorityScore(left) + toStremioCompatibilityScore(left))
      );
      const dedupeResult = applyConfiguredDedupe(configuredStreams, streamOptions);
      diagnostics.dedupedTotal = dedupeResult.removedCount;
      diagnostics.reasons.duplicate = dedupeResult.removedCount;
      diagnostics.examples.duplicate = dedupeResult.examples;

      res.json({
        resolved: true,
        tmdbId,
        providersTried: result.tried,
        providerOrder: result.providers,
        diagnostics,
        sample: dedupeResult.streams.slice(0, 6).map((stream) => ({
          name: stream.name,
          quality: stream.quality,
          host: getStreamHostname(stream),
          size: stream.size || null,
          url: stream.url || null
        }))
      });
    } catch (error) {
      next(error);
    }
  }

  async handleCacheStats(_req, res, next) {
    try {
      const stats = await this.cacheManager.getCacheStats(this.torrentEngine.getActiveCachePaths());
      res.json(stats);
    } catch (error) {
      next(error);
    }
  }

  async handleTorrentFileStream(req, res, next) {
    try {
      const descriptor = await this.torrentEngine.getStreamDescriptorByInfoHash({
        infoHash: req.params.infoHash,
        fileName: req.params.filename,
        rangeHeader: req.headers.range
      });

      await this.sendStream(res, descriptor);
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }

      next(error);
    }
  }

  async handleStreamRequest(input = {}) {
    if (typeof input.sourceId === 'string' && input.sourceId.trim()) {
      const resolved = this.sourceRegistry.get(input.sourceId.trim());

      if (!resolved) {
        throw createHttpError(404, 'Source id was not found or has expired');
      }

      return this.handleStreamRequest({
        ...input,
        type: resolved.type,
        source: resolved.source,
        headers: resolved.headers,
        metadata: resolved.metadata,
        fallback: resolved.fallback,
        sourceId: null
      });
    }

    const preparedSource = await this.prepareSource(input);
    const sourceType = preparedSource.type;
    const source = preparedSource.source;
    const fallback = preparedSource.fallback;

    if (sourceType === 'torrent') {
      return this.torrentEngine.getStreamDescriptor({
        magnet: source,
        fileIndex: input.fileIndex,
        fileName: input.fileName,
        rangeHeader: input.rangeHeader
      });
    }

    const cachedEntry = await this.cacheManager.getHttpCacheEntry(source);

    if (cachedEntry) {
      await this.cacheManager.touchPath(cachedEntry.dataPath);
      return this.httpProxy.createCachedDescriptor(cachedEntry, input.rangeHeader);
    }

    try {
      return await this.httpProxy.getUpstreamStreamDescriptor({
        targetUrl: source,
        rangeHeader: input.rangeHeader,
        requestHeaders: preparedSource.headers
      });
    } catch (error) {
      if (fallback?.type === 'torrent') {
        logger.warn('http source failed, falling back to torrent', {
          source,
          fallbackSource: fallback.source,
          error
        });

        return this.torrentEngine.getStreamDescriptor({
          magnet: fallback.source,
          fileIndex: input.fileIndex,
          fileName: input.fileName,
          rangeHeader: input.rangeHeader
        });
      }

      throw error;
    }
  }

  async prepareSource(input = {}) {
    const rawSource = input.source ?? input.url ?? input.magnet;
    const requestedType = normalizeRequestedType(input.type);
    const detectedType = detectSourceType(rawSource);
    const normalizedDetectedType = detectedType === 'magnet' ? 'torrent' : detectedType;

    if (!detectedType || !normalizedDetectedType) {
      throw createHttpError(400, 'A valid HTTP URL or magnet link is required');
    }

    if (requestedType && requestedType !== normalizedDetectedType) {
      throw createHttpError(400, `Query parameter type=${requestedType} does not match the provided source`);
    }

    if (normalizedDetectedType === 'http') {
      const normalizedUrl = input.deferValidation
        ? this.normalizeHttpSource(rawSource)
        : await this.httpProxy.validateTargetUrl(rawSource);

      return {
        type: 'http',
        source: normalizedUrl,
        streamSource: normalizedUrl,
        headers: input.headers && typeof input.headers === 'object' ? { ...input.headers } : null,
        metadata: input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : null,
        fallback: await this.prepareFallback(input.fallback),
        cached: await this.cacheManager.isCached(this.cacheManager.getHttpCacheKey(normalizedUrl))
      };
    }

    let magnet;

    try {
      magnet = enhanceMagnet(rawSource);
    } catch (error) {
      throw createHttpError(400, error.message);
    }

    const infoHash = extractInfoHash(magnet);

    if (!infoHash) {
      throw createHttpError(400, 'Invalid magnet URI');
    }

    const cached = await this.cacheManager.isCached(infoHash);

    return {
      type: 'torrent',
      source: magnet,
      streamSource: String(rawSource).trim(),
      headers: null,
      metadata: input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : null,
      fallback: null,
      cached
    };
  }

  async createRegisteredStreamUrl(baseUrl, input = {}) {
    const preparedSource = await this.prepareSource(input);
    const sourceId = this.sourceRegistry.register({
      type: preparedSource.type,
      source: preparedSource.source,
      headers: preparedSource.headers,
      metadata: preparedSource.metadata,
      fallback: preparedSource.fallback
    });
    const streamUrl = new URL('/stream', baseUrl);
    streamUrl.searchParams.set('sourceId', sourceId);
    return streamUrl;
  }

  async resolveHubCloudUrls(streamUrl, inheritedHeaders = null) {
    const normalizedUrl = String(streamUrl || '').trim();

    if (!isHubCloudUrl(normalizedUrl)) {
      return [];
    }

    const cached = this.hubCloudCache.get(normalizedUrl);

    if (cached && cached.expiresAt > Date.now()) {
      return Array.isArray(cached.value) ? cached.value.map((entry) => ({ ...entry })) : [];
    }

    if (this.hubCloudInFlight.has(normalizedUrl)) {
      return this.hubCloudInFlight.get(normalizedUrl);
    }

    const request = (async () => {
      try {
        const initialHeaders = {
          'User-Agent': HUBCLOUD_USER_AGENT,
          ...(inheritedHeaders && typeof inheritedHeaders === 'object' ? inheritedHeaders : {}),
          Referer: normalizedUrl
        };
        const initialHtml = await fetchTextWithTimeout(normalizedUrl, { headers: initialHeaders }, 8000);
        const redirectMatch = initialHtml.match(/var url ?= ?'([^']+)'/i)
          || initialHtml.match(/id=["']download["'][^>]*href=["']([^"']+)["']/i);

        if (!redirectMatch?.[1]) {
          this.hubCloudCache.set(normalizedUrl, { expiresAt: Date.now() + HUBCLOUD_CACHE_TTL_MS, value: [] });
          return [];
        }

        const redirectUrl = new URL(redirectMatch[1], normalizedUrl).toString();
        const linksHtml = await fetchTextWithTimeout(redirectUrl, {
          headers: {
            'User-Agent': HUBCLOUD_USER_AGENT,
            Referer: normalizedUrl
          }
        }, 8000);
        const title = parseHubCloudTitle(linksHtml);
        const size = parseHubCloudSize(linksHtml);
        const candidates = extractHubCloudAnchorCandidates(linksHtml)
          .map((candidate) => ({
            ...candidate,
            score: getHubCloudCandidateScore(candidate),
            server: classifyHubCloudCandidate(candidate)
          }))
          .filter((candidate) => candidate.score > 0)
          .sort((left, right) => right.score - left.score);

        if (candidates.length === 0) {
          this.hubCloudCache.set(normalizedUrl, { expiresAt: Date.now() + HUBCLOUD_CACHE_TTL_MS, value: [] });
          return [];
        }

        const deduped = [];
        const seenKeys = new Set();

        for (const candidate of candidates) {
          let resolvedHref = candidate.href;
          let resolvedHeaders = null;

          if (candidate.server === 'PixelServer') {
            try {
              const pixelUrl = new URL(candidate.href);
              const pixelPath = pixelUrl.pathname.replace(/\/api\/file\//i, '/u/');
              const refererUrl = new URL(pixelPath, pixelUrl.origin).toString();
              const downloadUrl = new URL(candidate.href);
              if (!/\/api\/file\//i.test(downloadUrl.pathname)) {
                downloadUrl.pathname = downloadUrl.pathname.replace(/\/u\//i, '/api/file/');
              }
              if (!downloadUrl.searchParams.has('download')) {
                downloadUrl.searchParams.set('download', '');
              }
              resolvedHref = downloadUrl.toString();
              resolvedHeaders = {
                Referer: refererUrl,
                'User-Agent': HUBCLOUD_USER_AGENT
              };
            } catch {
              resolvedHeaders = {
                Referer: redirectUrl,
                'User-Agent': HUBCLOUD_USER_AGENT
              };
            }
          } else if (candidate.href.toLowerCase().includes('hubcdn')) {
            resolvedHeaders = {
              Referer: redirectUrl,
              'User-Agent': HUBCLOUD_USER_AGENT
            };
          }

          const dedupeKey = `${candidate.server}:${resolvedHref}`;
          if (seenKeys.has(dedupeKey)) {
            continue;
          }
          seenKeys.add(dedupeKey);

          deduped.push({
            url: resolvedHref,
            headers: resolvedHeaders,
            sourceSite: `HubCloud (${candidate.server})`,
            title,
            size
          });
        }

        this.hubCloudCache.set(normalizedUrl, {
          expiresAt: Date.now() + HUBCLOUD_CACHE_TTL_MS,
          value: deduped
        });

        return deduped.map((entry) => ({ ...entry }));
      } catch (error) {
        logger.warn('hubcloud resolution failed', {
          streamUrl: normalizedUrl,
          error
        });
        this.hubCloudCache.set(normalizedUrl, {
          expiresAt: Date.now() + (10 * 60 * 1000),
          value: []
        });
        return [];
      }
    })();

    this.hubCloudInFlight.set(normalizedUrl, request);

    try {
      return await request;
    } finally {
      this.hubCloudInFlight.delete(normalizedUrl);
    }
  }

  async normalizeProviderStreams(_baseUrl, streams, fallbackProvider = null) {
    const settled = await Promise.all(streams.flatMap((stream) => {
      const provider = stream.provider || fallbackProvider;
      const variants = [];
      const normalizedUrl = typeof stream.url === 'string' ? stream.url.trim() : '';
      const normalizedMagnet = typeof stream.magnet === 'string'
        ? stream.magnet.trim()
        : typeof stream.torrent === 'string'
          ? stream.torrent.trim()
          : '';

      if (normalizedUrl) {
        variants.push({
          transport: 'http',
          source: normalizedUrl,
          headers: stream.headers
        });
      }

      if (normalizedMagnet) {
        variants.push({
          transport: 'torrent',
          source: normalizedMagnet,
          headers: null
        });
      }

      return variants.map(async (variant) => {
        try {
          const {
            url: _url,
            magnet: _magnet,
            torrent: _torrent,
            ...rest
          } = stream;
          const normalizedEntries = [];

          if (variant.transport === 'http' && isHubCloudUrl(normalizedUrl)) {
            const resolvedHubCloudEntries = await this.resolveHubCloudUrls(normalizedUrl, variant.headers);

            if (resolvedHubCloudEntries.length > 0) {
              for (const resolvedEntry of resolvedHubCloudEntries) {
                normalizedEntries.push({
                  ...rest,
                  provider,
                  ...(resolvedEntry.sourceSite ? { sourceSite: resolvedEntry.sourceSite } : {}),
                  ...(resolvedEntry.title || rest.title ? { title: resolvedEntry.title || rest.title } : {}),
                  ...(resolvedEntry.size || rest.size ? { size: resolvedEntry.size || rest.size } : {}),
                  headers: resolvedEntry.headers,
                  transport: 'http',
                  url: resolvedEntry.url,
                  filename: extractFilenameFromUrl(resolvedEntry.url)
                });
              }

              return normalizedEntries;
            }
          }

          return [{
            ...rest,
            provider,
            headers: variant.headers,
            transport: variant.transport,
            ...(variant.transport === 'http'
              ? {
                  url: normalizedUrl,
                  filename: extractFilenameFromUrl(normalizedUrl)
                }
              : {
                  magnet: normalizedMagnet,
                  infoHash: extractInfoHash(normalizedMagnet) || null,
                  sources: getTorrentSources(normalizedMagnet)
                })
          }];
        } catch (error) {
          logger.warn('provider stream skipped', {
            provider,
            source: variant.source,
            transport: variant.transport,
            error
          });
          return null;
        }
      });
    }));

    return settled.flat().filter(Boolean);
  }

  parseStremioStreamRequest(type, id) {
    const normalizedType = String(type || '').trim().toLowerCase();
    const normalizedId = String(id || '').trim();

    if (normalizedType !== 'movie' && normalizedType !== 'series') {
      throw createHttpError(400, 'Unsupported Stremio stream type');
    }

    if (normalizedType === 'movie') {
      return {
        mediaType: 'movie',
        imdbId: normalizedId,
        season: null,
        episode: null
      };
    }

    const [imdbId, rawSeason, rawEpisode] = normalizedId.split(':');
    const season = Number.parseInt(rawSeason, 10);
    const episode = Number.parseInt(rawEpisode, 10);

    if (!imdbId || !Number.isInteger(season) || !Number.isInteger(episode)) {
      throw createHttpError(400, 'Series stream id must be in imdb:season:episode format');
    }

    return {
      mediaType: 'series',
      imdbId,
      season,
      episode
    };
  }

  async prepareFallback(fallbackInput) {
    if (!fallbackInput || typeof fallbackInput !== 'object') {
      return null;
    }

    const fallbackType = normalizeRequestedType(fallbackInput.type);

    if (fallbackType !== 'torrent' || typeof fallbackInput.source !== 'string') {
      return null;
    }

    let magnet;

    try {
      magnet = enhanceMagnet(fallbackInput.source);
    } catch {
      return null;
    }

    const infoHash = extractInfoHash(magnet);

    if (!infoHash) {
      return null;
    }

    return {
      type: 'torrent',
      source: magnet,
      headers: null,
      metadata: fallbackInput.metadata && typeof fallbackInput.metadata === 'object'
        ? { ...fallbackInput.metadata }
        : null
    };
  }

  normalizeHttpSource(source) {
    let parsedUrl;

    try {
      parsedUrl = new URL(String(source || '').trim());
    } catch {
      throw createHttpError(400, 'Invalid upstream URL');
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw createHttpError(400, 'Only HTTP and HTTPS upstream URLs are supported');
    }

    if (!parsedUrl.hostname) {
      throw createHttpError(400, 'Invalid upstream URL');
    }

    return parsedUrl.toString();
  }

  async sendStream(res, descriptor) {
    if (this.activeStreams >= config.MAX_ACTIVE_STREAMS) {
      logger.warn('stream rejected due to active stream limit', {
        activeStreams: this.activeStreams,
        maxActiveStreams: config.MAX_ACTIVE_STREAMS
      });
      throw createHttpError(503, 'Server is at active stream capacity');
    }

    const {
      stream,
      statusCode = 200,
      headers = {},
      cleanup = null
    } = descriptor;

    let completed = false;
    this.activeStreams += 1;

    try {
      res.status(statusCode);

      for (const [headerName, headerValue] of Object.entries(headers)) {
        if (headerValue !== undefined && headerValue !== null) {
          res.setHeader(headerName, String(headerValue));
        }
      }

      await pipeline(stream, res);
      completed = true;
    } catch (error) {
      logger.error('stream pipeline failed', {
        activeStreams: this.activeStreams,
        error
      });
      throw error;
    } finally {
      this.activeStreams = Math.max(this.activeStreams - 1, 0);

      if (typeof cleanup === 'function') {
        await cleanup({ completed });
      }
    }
  }
}
