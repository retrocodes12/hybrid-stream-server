'use strict';

const BASE_URLS = Object.freeze([
  'https://allyoucanwatch.net',
  'https://allyoucanwatch.xyz'
]);

const DEFAULT_HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  'Accept': 'text/event-stream,application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9'
});

const TAG = '[AllYouCanWatch]';

function normalizeMediaType(mediaType) {
  return mediaType === 'tv' ? 'series' : 'movie';
}

function normalizeValue(value) {
  return String(value || '').trim();
}

function toAbsoluteUrl(baseUrl, value) {
  const normalized = normalizeValue(value);
  if (!normalized) {
    return '';
  }

  try {
    return new URL(normalized, baseUrl).toString();
  } catch (_) {
    return normalized;
  }
}

function buildPlayerUrl(baseUrl, tmdbId, mediaType, season, episode) {
  if (mediaType === 'series') {
    return `${baseUrl}/player/new_player.html?tmdb=${tmdbId}&type=series&s=${season || 1}&e=${episode || 1}&prefServer=auto&prefQuality=auto`;
  }

  return `${baseUrl}/player/new_player.html?tmdb=${tmdbId}&prefServer=auto&prefQuality=auto`;
}

function buildSseUrl(baseUrl, tmdbId, mediaType, season, episode) {
  if (mediaType === 'series') {
    return `${baseUrl}/api/sources/stream?tmdb=${tmdbId}&s=${season || 1}&e=${episode || 1}`;
  }

  return `${baseUrl}/api/sources/stream?tmdb=${tmdbId}`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 18000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function parseSsePayloads(rawText) {
  const payloads = [];
  const chunks = String(rawText || '').split(/\n\n+/);

  for (const chunk of chunks) {
    const dataLines = chunk
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);

    if (dataLines.length === 0) {
      continue;
    }

    try {
      payloads.push(JSON.parse(dataLines.join('\n')));
    } catch (error) {
      console.warn(`${TAG} failed to parse SSE payload: ${error.message}`);
    }
  }

  return payloads;
}

function parseSubtitleLanguages(captions) {
  const languages = [];

  for (const caption of Array.isArray(captions) ? captions : []) {
    const language = normalizeValue(caption && caption.language)
      .replace(/\s*-\s*.*/g, '')
      .trim();

    if (language && !languages.includes(language)) {
      languages.push(language);
    }
  }

  return languages;
}

function buildMovieStreams(baseUrl, payload) {
  const entries = Array.isArray(payload && payload.streams) ? payload.streams : [];
  const streams = [];

  for (const entry of entries) {
    const url = normalizeValue(entry && entry.url);
    if (!url) {
      continue;
    }

    const quality = normalizeValue(entry && entry.quality) || 'Auto';
    const title = normalizeValue(entry && entry.title) || 'AllYouCanWatch';
    const provider = normalizeValue(entry && entry.provider) || 'Provider';
    const size = normalizeValue(entry && entry.size);

    streams.push({
      name: `AllYouCanWatch | ${quality}`,
      title: [
        title,
        `${provider}${size ? ` | ${size}` : ''}`
      ].join('\n'),
      url: toAbsoluteUrl(baseUrl, url),
      quality,
      headers: entry && typeof entry.headers === 'object' ? entry.headers : undefined,
      provider: 'allyoucanwatch',
      sourceProvider: provider
    });
  }

  return streams;
}

function buildSeriesStream(baseUrl, payload, tmdbId, season, episode) {
  const url = normalizeValue(payload && payload.url);
  if (!url) {
    return null;
  }

  const sourceProvider = normalizeValue(payload && payload.type) || 'Provider';
  const subtitleLanguages = parseSubtitleLanguages(payload && payload.captions);
  const subtitleLabel = subtitleLanguages.length > 0
    ? ` | Subs: ${subtitleLanguages.join(', ')}`
    : '';

  return {
    name: 'AllYouCanWatch | Auto',
    title: [
      `TMDB ${tmdbId} S${String(season || 1).padStart(2, '0')}E${String(episode || 1).padStart(2, '0')}`,
      `${sourceProvider}${subtitleLabel}`
    ].join('\n'),
    url: toAbsoluteUrl(baseUrl, url),
    quality: 'Auto',
    headers: {
      Referer: baseUrl
    },
    provider: 'allyoucanwatch',
    sourceProvider
  };
}

function dedupeStreams(streams) {
  const deduped = [];
  const seen = new Set();

  for (const stream of streams) {
    const key = `${normalizeValue(stream && stream.url)}|${normalizeValue(stream && stream.name)}`;
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(stream);
  }

  return deduped;
}

async function tryFetchStreams(baseUrl, tmdbId, mediaType, season, episode) {
  const playerUrl = buildPlayerUrl(baseUrl, tmdbId, mediaType, season, episode);
  const sseUrl = buildSseUrl(baseUrl, tmdbId, mediaType, season, episode);
  const response = await fetchWithTimeout(sseUrl, {
    headers: {
      ...DEFAULT_HEADERS,
      Referer: playerUrl
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const rawText = await response.text();
  const payloads = parseSsePayloads(rawText);
  if (payloads.length === 0) {
    return [];
  }

  const streams = [];

  for (const payload of payloads) {
    if (Array.isArray(payload && payload.streams)) {
      streams.push(...buildMovieStreams(baseUrl, payload));
      continue;
    }

    const seriesStream = buildSeriesStream(baseUrl, payload, tmdbId, season, episode);
    if (seriesStream) {
      streams.push(seriesStream);
    }
  }

  return dedupeStreams(streams);
}

async function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  const normalizedMediaType = normalizeMediaType(mediaType);

  for (const baseUrl of BASE_URLS) {
    try {
      const streams = await tryFetchStreams(baseUrl, tmdbId, normalizedMediaType, season, episode);
      if (streams.length > 0) {
        console.log(`${TAG} ${normalizedMediaType} ${tmdbId} -> ${streams.length} streams via ${baseUrl}`);
        return streams;
      }
    } catch (error) {
      console.warn(`${TAG} ${normalizedMediaType} ${tmdbId} failed via ${baseUrl}: ${error.message}`);
    }
  }

  console.log(`${TAG} ${normalizedMediaType} ${tmdbId} -> 0 streams`);
  return [];
}

module.exports = { getStreams };
