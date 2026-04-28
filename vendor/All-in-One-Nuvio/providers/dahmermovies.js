// Dahmer Movies Scraper - Final 404/Doubling Fix
// Optimized for TV/Mobile Playback

console.log('[DahmerMovies] Initializing Scraper');

const TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c";
const DAHMER_MOVIES_API = 'https://a.111477.xyz';

async function makeRequest(url) {
    const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
}

// This gets the actual direct stream link
async function resolveFinalUrl(startUrl) {
    try {
        const response = await fetch(startUrl, {
            method: 'HEAD',
            redirect: 'follow',
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Android) ExoPlayer',
                'Referer': DAHMER_MOVIES_API + '/'
            }
        });
        return response.url;
    } catch (e) {
        return startUrl;
    }
}

function parseLinks(html) {
    const links = [];
    const rowRegex = /<tr[^>]*>(.*?)<\/tr>/gis;
    let match;
    while ((match = rowRegex.exec(html)) !== null) {
        const content = match[1];
        const linkMatch = content.match(/<a[^>]*href=["']([^"']*)["'][^>]*>([^<]*)<\/a>/i);
        if (linkMatch) {
            const href = linkMatch[1];
            const text = linkMatch[2].trim();
            // Skip parent directories and only take video files
            if (text && href !== '../' && /\.(mkv|mp4|avi|webm)$/i.test(text)) {
                links.push({ text, href });
            }
        }
    }
    return links;
}

async function invokeDahmerMovies(title, year, season = null, episode = null) {
    const cleanTitle = title.replace(/:/g, '');
    const folderName = season === null ? `${cleanTitle} (${year})` : cleanTitle;
    
    // The directory we are scanning
    const directoryUrl = season === null 
        ? `${DAHMER_MOVIES_API}/movies/${encodeURIComponent(folderName)}/`
        : `${DAHMER_MOVIES_API}/tvs/${encodeURIComponent(folderName)}/Season ${season}/`;

    try {
        const response = await makeRequest(directoryUrl);
        const html = await response.text();
        const paths = parseLinks(html);

        let filtered = paths;
        if (season !== null) {
            const s = season < 10 ? `0${season}` : season;
            const e = episode < 10 ? `0${episode}` : episode;
            const pattern = new RegExp(`S${s}E${e}`, 'i');
            filtered = paths.filter(p => pattern.test(p.text));
        }

        const results = [];
        for (const path of filtered.slice(0, 3)) {
            let absoluteUrl;

            if (path.href.startsWith('http')) {
                absoluteUrl = path.href;
            } else if (path.href.startsWith('/')) {
                // Join with domain only (prevents doubling)
                absoluteUrl = new URL(DAHMER_MOVIES_API).origin + path.href;
            } else {
                // Filename only - join with directory
                absoluteUrl = directoryUrl + path.href;
            }

            // Clean up double slashes (except the one after http:)
            absoluteUrl = absoluteUrl.replace(/([^:]\/)\/+/g, "$1");

            const finalStreamUrl = await resolveFinalUrl(absoluteUrl);

            results.push({
                name: "DahmerMovies",
                title: path.text,
                url: finalStreamUrl,
                quality: path.text.includes('2160p') ? '2160p' : '1080p',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Android) ExoPlayer',
                    'Referer': DAHMER_MOVIES_API + '/'
                },
                provider: "dahmermovies"
            });
        }
        return results;
    } catch (e) {
        console.log("[DahmerMovies] Error:", e.message);
        return [];
    }
}

async function getStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    try {
        const res = await makeRequest(`https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${TMDB_API_KEY}`);
        const data = await res.json();
        const title = mediaType === 'tv' ? data.name : data.title;
        const year = (mediaType === 'tv' ? data.first_air_date : data.release_date)?.substring(0, 4);
        return await invokeDahmerMovies(title, year, seasonNum, episodeNum);
    } catch (e) {
        return [];
    }
}

if (typeof module !== 'undefined') module.exports = { getStreams };
else global.getStreams = getStreams;
