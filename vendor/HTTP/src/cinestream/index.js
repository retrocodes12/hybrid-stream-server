/**
 * CineStream Provider for Nuvio
 * ported from SaurabhKaperwanCSX ported by kabir
 */

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const API_BASE = "https://87d6a6ef6b58-webstreamrmbg.baby-beamup.club";

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
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) {
        throw new Error(`TMDB lookup failed with ${res.status}`);
    }
    const data = await res.json();
    return {
        imdbId: data.external_ids?.imdb_id,
        title: normalizedMediaType === 'tv' ? data.name : data.title
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
        if (normalizedMediaType === 'movie') {
            urls = [
                ...(info?.imdbId ? [`${API_BASE}/stream/movie/${info.imdbId}.json`] : []),
                `${API_BASE}/stream/movie/tmdb:${tmdbId}.json`
            ];
        } else if (info?.imdbId) {
            urls = buildSeriesCandidateUrls(API_BASE, info.imdbId, tmdbId, season, episode);
        } else {
            urls = [`${API_BASE}/stream/${streamContentType}/tmdb:${tmdbId}:${Number(season) || 0}:${Number(episode) || 0}.json`];
        }

        const data = urls.length > 0 ? await fetchFirstWorkingPayload(urls) : null;
        const upstreamStreams = data?.streams || [];
        const directFallbackStreams = await fetchDirectFallbackStreams(tmdbId, normalizedMediaType, season, episode);
        const streams = dedupeStreams([...upstreamStreams, ...directFallbackStreams])
            .filter(s => normalizeStreamUrl(s?.url));
        if (streams.length === 0) return [];

        return streams.map(s => {
            const quality = detectQualityLabel(`${s.name || ''} ${s.title || ''}`);
            const upstreamName = rewriteUpstreamLabel(s.name || '');
            const fallbackName = quality === 'Auto' ? 'NebulaStreams' : `NebulaStreams ${quality}`;
            const title = String(s.title || s.name || fallbackName);

            return {
                name: `CS [${upstreamName || fallbackName}]`,
                title: rewriteUpstreamLabel(title.split('\n')[0]),
                url: normalizeStreamUrl(s.url),
                quality,
                headers: s.behaviorHints?.proxyHeaders?.request || { "Referer": API_BASE }
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
