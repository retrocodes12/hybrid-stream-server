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

function pad2(value) {
    return String(Number(value) || 0).padStart(2, '0');
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

/**
 * Get IMDB ID from TMDB
 */
async function getIMDBId(tmdbId, mediaType) {
    const url = `${TMDB_BASE_URL}/${mediaType}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    const data = await res.json();
    return {
        imdbId: data.external_ids?.imdb_id,
        title: mediaType === 'tv' ? data.name : data.title
    };
}

/**
 * Main function called by Nuvio
 */
async function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
    try {
        const info = await getIMDBId(tmdbId, mediaType);
        if (!info.imdbId) return [];

        let urls = [];
        if (mediaType === 'movie') {
            urls = [`${API_BASE}/stream/movie/${info.imdbId}.json`];
        } else {
            urls = buildSeriesCandidateUrls(API_BASE, info.imdbId, tmdbId, season, episode);
        }

        const data = await fetchFirstWorkingPayload(urls);
        if (!data) return [];
        const streams = data.streams || [];

        return streams.map(s => {
            const quality = detectQualityLabel(`${s.name || ''} ${s.title || ''}`);
            const upstreamName = rewriteUpstreamLabel(s.name || '');
            const fallbackName = quality === 'Auto' ? 'NebulaStreams' : `NebulaStreams ${quality}`;

            return {
                name: `CS [${upstreamName || fallbackName}]`,
                title: rewriteUpstreamLabel(s.title.split('\n')[0]),
                url: s.url,
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
