/**
 * CineStream Provider for Nuvio
 * ported from SaurabhKaperwanCSX ported by kabir
 */

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const API_BASE = "https://87d6a6ef6b58-webstreamrmbg.baby-beamup.club";
const PLAYABLE_CHECK_TIMEOUT_MS = 7000;
const PLAYABLE_EXTENSION_PATTERN = /\.(?:mp4|mkv|webm|m3u8)(?:[?#]|$)/i;
const HTML_WRAPPER_HOSTS = new Set(['hubcdn.fans']);

const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json"
};
const DIRECT_FALLBACK_PROVIDERS = mediaType => (
    mediaType === 'tv' || mediaType === 'series'
        ? ['./4khdhub.js', './hdhub4u.js']
        : []
);

function detectQualityLabel(value) {
    const text = String(value || "");
    const match = text.match(/\b(2160p|4k|1440p|1080p|720p|480p|360p)\b/i);
    if (!match) return "Auto";
    const normalized = match[1].toLowerCase();
    return normalized === "4k" ? "2160p" : normalized;
}

function rewriteUpstreamLabel(value) {
    return String(value || "")
        .replace(/WebStreamrMBG/gi, "NebulaStreams")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizeStreamUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';

    try {
        const parsedUrl = new URL(raw);
        const apiBaseUrl = new URL(API_BASE);

        if (parsedUrl.hostname === '87d6a6ef6b58-webstreamrmbg') {
            parsedUrl.hostname = apiBaseUrl.hostname;
        }

        return parsedUrl.toString();
    } catch (error) {
        return raw;
    }
}

function pad2(value) {
    return String(Number(value) || 0).padStart(2, '0');
}

function normalizeMediaType(mediaType) {
    const normalized = String(mediaType || 'movie').trim().toLowerCase();
    return normalized === 'series' ? 'tv' : normalized;
}

function toStreamContentType(mediaType) {
    return normalizeMediaType(mediaType) === 'tv' ? 'series' : 'movie';
}

function normalizeTitleKey(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]+/g, '');
}

function streamMatchesRequestedContent(stream, info) {
    const expectedTitle = normalizeTitleKey(info?.title);
    if (!expectedTitle) return true;

    const streamTitle = normalizeTitleKey(`${stream?.title || ''} ${stream?.name || ''}`);
    if (!streamTitle) return true;

    return streamTitle.includes(expectedTitle) || expectedTitle.includes(streamTitle);
}

function isKnownHtmlWrapperUrl(value) {
    try {
        return HTML_WRAPPER_HOSTS.has(new URL(value).hostname.toLowerCase());
    } catch {
        return false;
    }
}

function hasPlayableExtension(value) {
    return PLAYABLE_EXTENSION_PATTERN.test(String(value || ''));
}

function isApiBaseUrl(value) {
    try {
        return new URL(value).hostname.toLowerCase() === new URL(API_BASE).hostname.toLowerCase();
    } catch {
        return false;
    }
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry(url, options = {}, attempts = 3) {
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const res = await fetch(url, options);
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            return await res.json();
        } catch (error) {
            lastError = error;
            if (attempt < attempts) {
                await wait(250 * attempt);
            }
        }
    }

    throw lastError || new Error('Request failed');
}

async function resolvePlayableStream(stream) {
    const url = normalizeStreamUrl(stream?.url);
    if (!url || isKnownHtmlWrapperUrl(url)) return null;

    if (hasPlayableExtension(url)) {
        return { ...stream, url };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PLAYABLE_CHECK_TIMEOUT_MS);

    try {
        const res = await fetch(url, {
            headers: {
                ...(stream?.headers || {}),
                Range: 'bytes=0-1023'
            },
            redirect: 'follow',
            signal: controller.signal
        });

        const contentType = String(res.headers.get('content-type') || '').toLowerCase();
        const contentLength = Number.parseInt(res.headers.get('content-length') || '0', 10);
        const contentRange = String(res.headers.get('content-range') || '');
        const finalUrl = normalizeStreamUrl(res.url || url);

        await res.body?.cancel?.();

        if (!res.ok && res.status !== 206) return null;
        if (contentType.includes('text/html')) return null;

        const videoLike = contentType.startsWith('video/')
            || contentType.includes('mpegurl')
            || contentType.includes('application/vnd.apple.mpegurl')
            || (contentType.includes('application/octet-stream') && (hasPlayableExtension(finalUrl) || contentLength > 1048576))
            || Boolean(contentRange);

        return videoLike ? { ...stream, url: finalUrl } : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

async function filterPlayableStreams(streams, info) {
    const output = [];
    const seen = new Set();

    for (const stream of Array.isArray(streams) ? streams : []) {
        if (!streamMatchesRequestedContent(stream, info)) continue;

        const playable = await resolvePlayableStream(stream);
        if (playable) {
            const key = normalizeStreamUrl(playable.url);
            if (seen.has(key)) continue;
            seen.add(key);
            output.push(playable);
        }
    }

    return output;
}

function buildSeriesCandidateUrls(apiBase, imdbId, tmdbId, season, episode) {
    const seasonValue = Number(season) || 0;
    const episodeValue = Number(episode) || 0;
    const seasonPadded = pad2(seasonValue);
    const episodePadded = pad2(episodeValue);
    const ids = [
        `${imdbId}:${seasonValue}:${episodeValue}`,
        `${imdbId}:${seasonPadded}:${episodePadded}`,
        `tmdb:${tmdbId}:${seasonValue}:${episodeValue}`,
        `tmdb:${tmdbId}:${seasonPadded}:${episodePadded}`
    ];
    const candidates = [];

    for (const route of ['series', 'tv']) {
        for (const id of ids) {
            candidates.push(`${apiBase}/stream/${route}/${id}.json`);
        }
    }

    return candidates;
}

async function fetchFirstWorkingPayload(urls) {
    for (const url of urls) {
        console.log(`[CineStream] Fetching: ${url}`);
        try {
            const res = await fetch(url, { headers: HEADERS });
            if (!res.ok) continue;
            const data = await res.json();
            if (Array.isArray(data?.streams) && data.streams.length > 0) {
                return data;
            }
        } catch (error) {
            console.log(`[CineStream] Candidate failed: ${error.message}`);
        }
    }

    return null;
}

async function fetchDirectFallbackStreams(tmdbId, mediaType, season, episode) {
    const fallbackStreams = [];

    for (const modulePath of DIRECT_FALLBACK_PROVIDERS(mediaType)) {
        try {
            const provider = require(modulePath);
            if (!provider || typeof provider.getStreams !== 'function') continue;
            const streams = await provider.getStreams(tmdbId, mediaType, season, episode);
            if (Array.isArray(streams) && streams.length > 0) {
                fallbackStreams.push(...streams);
            }
        } catch (error) {
            console.log(`[CineStream] Direct fallback failed for ${modulePath}: ${error.message}`);
        }
    }

    return fallbackStreams;
}

function dedupeStreams(streams) {
    const output = [];
    const seen = new Set();

    for (const stream of Array.isArray(streams) ? streams : []) {
        const key = JSON.stringify({
            url: String(stream?.url || '').trim() || null,
            magnet: String(stream?.magnet || stream?.torrent || '').trim() || null,
            quality: String(stream?.quality || '').trim().toLowerCase() || null
        });

        if (seen.has(key)) continue;
        seen.add(key);
        output.push(stream);
    }

    return output;
}

/**
 * Get IMDB ID from TMDB
 */
async function getIMDBId(tmdbId, mediaType) {
    const normalizedMediaType = normalizeMediaType(mediaType);
    const url = `${TMDB_BASE_URL}/${normalizedMediaType}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;
    const data = await fetchJsonWithRetry(url, { headers: { 'Accept': 'application/json' } });
    return {
        imdbId: data.external_ids?.imdb_id,
        title: normalizedMediaType === 'tv' ? data.name : data.title,
        year: String((normalizedMediaType === 'tv' ? data.first_air_date : data.release_date) || '').slice(0, 4)
    };
}

/**
 * Main function called by Nuvio
 */
async function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
    try {
        const normalizedMediaType = normalizeMediaType(mediaType);
        const streamContentType = toStreamContentType(normalizedMediaType);
        let info = null;
        try {
            info = await getIMDBId(tmdbId, normalizedMediaType);
        } catch (error) {
            console.log(`[CineStream] TMDB lookup failed: ${error.message}`);
        }

        let urls = [];
        if (normalizedMediaType === 'movie' && info?.title) {
            urls = [
                ...(info?.imdbId ? [`${API_BASE}/stream/movie/${info.imdbId}.json`] : []),
                `${API_BASE}/stream/movie/tmdb:${tmdbId}.json`
            ];
        } else if (info?.imdbId) {
            urls = buildSeriesCandidateUrls(API_BASE, info.imdbId, tmdbId, season, episode);
        } else if (normalizedMediaType !== 'movie') {
            urls = [`${API_BASE}/stream/${streamContentType}/tmdb:${tmdbId}:${Number(season) || 0}:${Number(episode) || 0}.json`];
        }

        const data = urls.length > 0 ? await fetchFirstWorkingPayload(urls) : null;
        const upstreamStreams = data?.streams || [];
        const directFallbackStreams = await fetchDirectFallbackStreams(tmdbId, normalizedMediaType, season, episode);
        const streams = await filterPlayableStreams(
            dedupeStreams([...upstreamStreams, ...directFallbackStreams])
                .filter(s => normalizeStreamUrl(s?.url)),
            info
        );
        if (streams.length === 0) return [];

        return streams.map(s => {
            const quality = detectQualityLabel(`${s.name || ''} ${s.title || ''}`);
            const upstreamName = rewriteUpstreamLabel(s.name || '');
            const fallbackName = quality === 'Auto' ? 'NebulaStreams' : `NebulaStreams ${quality}`;
            const title = String(s.title || s.name || fallbackName);
            const requestHeaders = isApiBaseUrl(s.url)
                ? (s.headers || s.behaviorHints?.proxyHeaders?.request || { "Referer": API_BASE })
                : null;

            return {
                name: `CS [${upstreamName || fallbackName}]`,
                title: rewriteUpstreamLabel(title.split('\n')[0]),
                url: normalizeStreamUrl(s.url),
                quality,
                headers: requestHeaders
            };
        });

    } catch (e) {
        console.error("[CineStream] Error:", e.message);
        return [];
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { getStreams };
} else {
    global.getStreams = { getStreams };
}
