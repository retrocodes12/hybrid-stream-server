// =============================================================
// Provider Nuvio : Movix (VF/VOSTFR français)
// Version : 4.5.0
// - Added: S[X] E[X] - Episode Name support
// - Visual: Integrated Icons and ToFlix-style formatting
// =============================================================

var TMDB_KEY = 'f3d757824f08ea2cff45eb8f47ca3a1e';
var DOMAINS_URL = 'https://raw.githubusercontent.com/wooodyhood/nuvio-repo/main/domains.json';
var MOVIX_FALLBACK = 'cash';

var _cachedEndpoint = null;

// ─── TMDB Helpers ───────────────────────────────────────────

function getMovieTitle(tmdbId, type) {
    var url = 'https://api.themoviedb.org/3/' + (type === 'tv' ? 'tv' : 'movie') + '/' + tmdbId + '?api_key=' + TMDB_KEY + '&language=en-US';
    return fetch(url)
        .then(function(res) { return res.json(); })
        .then(function(data) {
            return data.title || data.name || "Movix";
        })
        .catch(function() { return "Movix"; });
}

function getEpisodeName(tmdbId, season, episode) {
    if (!tmdbId || !season || !episode) return Promise.resolve(null);
    var url = 'https://api.themoviedb.org/3/tv/' + tmdbId + '/season/' + season + '/episode/' + episode + '?api_key=' + TMDB_KEY + '&language=en-US';
    return fetch(url)
        .then(function(res) { return res.json(); })
        .then(function(data) {
            return data.name || null;
        })
        .catch(function() { return null; });
}

// ─── UI / Formatting ─────────────────────────────────────────

function buildTitle(provider, res, lang, format, size, extra, season, episode, epName) {
    var qIcon = (res.includes('2160') || res.includes('4K')) ? '💎' : '📺';
    var lIcon = '🇫🇷';
    var displayLang = 'VF';

    var check = (provider + " " + lang + " " + res).toUpperCase();
    if (check.indexOf('MULTI') !== -1) {
        lIcon = '🌍';
        displayLang = 'MULTI';
    } else if (check.indexOf('VOST') !== -1) {
        lIcon = '🔡';
        displayLang = 'VOSTFR';
    }

    // Season/Episode Logic
    var sePrefix = "";
    if (season && episode) {
        sePrefix = 'S' + season + ' E' + episode;
        if (epName) sePrefix += ' - ' + epName;
        sePrefix += ' | ';
    }

    // Clean Provider Name (Movie Title)
    var cleanName = provider.length > 25 ? provider.substring(0, 22) + "..." : provider;

    var columns = [
        '🎬 ' + sePrefix + cleanName,
        qIcon + ' ' + res,
        lIcon + ' ' + displayLang,
        '🎞️ ' + (format || 'M3U8').toUpperCase()
    ];

    if (size) columns.push('💾 ' + size);
    if (extra) columns.push('🛠️ ' + extra);

    return columns.join(' | ');
}

// ─── Network Logic ───────────────────────────────────────────

function detectApi() {
    if (_cachedEndpoint) return Promise.resolve(_cachedEndpoint);
    return fetch(DOMAINS_URL)
        .then(function(res) { return res.ok ? res.json() : Promise.reject(); })
        .then(function(data) {
            var tld = data.movix || MOVIX_FALLBACK;
            _cachedEndpoint = { api: 'https://api.movix.' + tld, referer: 'https://movix.' + tld + '/' };
            return _cachedEndpoint;
        })
        .catch(function() {
            _cachedEndpoint = { api: 'https://api.movix.' + MOVIX_FALLBACK, referer: 'https://movix.' + MOVIX_FALLBACK + '/' };
            return _cachedEndpoint;
        });
}

function resolveRedirect(url, referer) {
    return fetch(url, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': referer } })
        .then(function(res) { return res.url || url; }).catch(function() { return url; });
}

function resolveEmbed(embedUrl, referer) {
    return fetch(embedUrl, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': referer } })
        .then(function(res) { return res.text(); })
        .then(function(html) {
            var patterns = [/file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i, /source\s+src=["']([^"']+\.m3u8[^"']*)["']/i, /["']([^"']*\.m3u8(?:\?[^"']*)?)["']/i];
            for (var i = 0; i < patterns.length; i++) {
                var match = html.match(patterns[i]);
                if (match) return match[1].startsWith('//') ? 'https:' + match[1] : match[1];
            }
            return null;
        }).catch(function() { return null; });
}

// ─── API Fetches ─────────────────────────────────────────────

function fetchPurstream(apiBase, referer, tmdbId, mediaType, season, episode) {
    var url = mediaType === 'tv' ? apiBase + '/api/purstream/tv/' + tmdbId + '/stream?season=' + (season || 1) + '&episode=' + (episode || 1) : apiBase + '/api/purstream/movie/' + tmdbId + '/stream';
    return fetch(url, { headers: { 'Referer': referer } }).then(function(res) { return res.json(); }).then(function(data) { return data.sources || []; });
}

function fetchCpasmal(apiBase, referer, tmdbId, mediaType, season, episode) {
    var url = mediaType === 'tv' ? apiBase + '/api/cpasmal/tv/' + tmdbId + '/' + (season || 1) + '/' + (episode || 1) : apiBase + '/api/cpasmal/movie/' + tmdbId;
    return fetch(url, { headers: { 'Referer': referer } }).then(function(res) { return res.json(); }).then(function(data) {
        var sources = [];
        ['vf', 'vostfr'].forEach(function(l) { if (data.links && data.links[l]) data.links[l].forEach(function(link) { sources.push({ url: link.url, name: 'Movix', player: link.server, lang: l }); }); });
        return sources;
    });
}

// ─── Processing ──────────────────────────────────────────────

function tryFetchAll(apiBase, referer, tmdbId, mediaType, season, episode, movieName, epName) {
    return fetchPurstream(apiBase, referer, tmdbId, mediaType, season, episode)
        .then(function(sources) {
            return Promise.all(sources.map(function(source) {
                return resolveRedirect(source.url, referer).then(function(resolvedUrl) {
                    var qual = (source.name || "").indexOf('1080') !== -1 ? '1080p' : '720p';
                    return {
                        name: 'Movix - ' + qual,
                        title: buildTitle(movieName, qual, source.name, source.format || 'm3u8', null, null, season, episode, epName),
                        url: resolvedUrl,
                        quality: qual,
                        format: source.format || 'm3u8',
                        headers: { 'User-Agent': 'Mozilla/5.0' }
                    };
                });
            }));
        })
        .catch(function() {
            return fetchCpasmal(apiBase, referer, tmdbId, mediaType, season, episode).then(function(sources) {
                return Promise.all(sources.slice(0, 5).map(function(s) {
                    return resolveEmbed(s.url, referer).then(function(directUrl) {
                        if (!directUrl) return null;
                        return {
                            name: 'Movix - HD',
                            title: buildTitle(movieName, 'HD', s.lang, 'm3u8', '', s.player, season, episode, epName),
                            url: directUrl,
                            quality: 'HD',
                            format: 'm3u8',
                            headers: { 'Referer': referer }
                        };
                    });
                })).then(function(res) { return res.filter(function(r) { return r !== null; }); });
            });
        });
}

// ─── Entry Point ─────────────────────────────────────────────

function getStreams(tmdbId, mediaType, season, episode) {
    return Promise.all([
        getMovieTitle(tmdbId, mediaType),
        mediaType === 'tv' ? getEpisodeName(tmdbId, season, episode) : Promise.resolve(null),
        detectApi()
    ]).then(function(results) {
        var movieName = results[0];
        var epName = results[1];
        var endpoint = results[2];

        return tryFetchAll(endpoint.api, endpoint.referer, tmdbId, mediaType, season, episode, movieName, epName);
    }).catch(function() { return []; });
}

if (typeof module !== 'undefined' && module.exports) module.exports = { getStreams };
else global.getStreams = getStreams;
