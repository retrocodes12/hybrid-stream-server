// =============================================================
// Provider Nuvio : Purstream.art (VF/VOSTFR/MULTI)
// Version : 4.0.0
// - Bold Top Line: Purstream - Quality
// - Sub-description: S[X] E[X] - Episode Name | English Title | Icons
// =============================================================

var DOMAINS_URL           = 'https://raw.githubusercontent.com/wooodyhood/nuvio-repo/main/domains.json';
var PURSTREAM_FALLBACK    = 'cx';
var PURSTREAM_API         = 'https://api.purstream.' + PURSTREAM_FALLBACK + '/api/v1';
var PURSTREAM_REFERER     = 'https://purstream.' + PURSTREAM_FALLBACK + '/';
var PURSTREAM_UA          = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
var TMDB_KEY              = 'f3d757824f08ea2cff45eb8f47ca3a1e';

var _cachedEndpoint = null;

// ─── TMDB Helpers ───────────────────────────────────────────

function getEnglishTitle(tmdbId, type) {
  var url = 'https://api.themoviedb.org/3/' + (type === 'tv' ? 'tv' : 'movie') + '/' + tmdbId + '?api_key=' + TMDB_KEY + '&language=en-US';
  return fetch(url)
    .then(function(res) { return res.json(); })
    .then(function(data) {
      return data.title || data.name || "Purstream";
    })
    .catch(function() { return "Purstream"; });
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

// ─── UI Helper: Title Builder ────────────────────────────────

function buildPurstreamTitle(movieName, res, lang, format, season, episode, epName) {
    var qIcon = (res.includes('2160') || res.includes('4K')) ? '💎' : '📺';
    var lIcon = '🇫🇷';
    var displayLang = 'VF';

    var check = (lang || "").toUpperCase();
    if (check.indexOf('MULTI') !== -1) {
        lIcon = '🌍';
        displayLang = 'MULTI';
    } else if (check.indexOf('VOST') !== -1) {
        lIcon = '🔡';
        displayLang = 'VOSTFR';
    }

    // Season/Episode + Episode Name Logic
    var seInfo = "";
    if (season && episode) {
        seInfo = 'S' + season + ' E' + episode;
        if (epName) {
            seInfo += ' - ' + epName; 
        }
        seInfo += ' | ';
    }
    
    var cleanName = movieName.length > 18 ? movieName.substring(0, 16) + ".." : movieName;

    var columns = [
        '🎬 ' + seInfo + cleanName,
        qIcon + ' ' + res,
        lIcon + ' ' + displayLang,
        '🎞️ ' + (format || 'M3U8').toUpperCase()
    ];

    return columns.join(' | ');
}

// ─── API & Domain Logic ──────────────────────────────────────

function detectPurstreamDomain() {
  if (_cachedEndpoint) return Promise.resolve(_cachedEndpoint);
  return fetch(DOMAINS_URL)
    .then(function(res) { if (!res.ok) throw new Error(); return res.json(); })
    .then(function(data) {
      var tld = data.purstream || PURSTREAM_FALLBACK;
      _cachedEndpoint = { api: 'https://api.purstream.' + tld + '/api/v1', referer: 'https://purstream.' + tld + '/' };
      return _cachedEndpoint;
    })
    .catch(function() {
      return { api: 'https://api.purstream.' + PURSTREAM_FALLBACK + '/api/v1', referer: 'https://purstream.' + PURSTREAM_FALLBACK + '/' };
    });
}

function applyPurstreamDomain(endpoint) {
  PURSTREAM_API     = endpoint.api;
  PURSTREAM_REFERER = endpoint.referer;
}

function cleanTitle(s) {
  if (!s) return '';
  return s.toLowerCase().replace(/[àáâãäå]/g, 'a').replace(/[èéêë]/g, 'e').replace(/[ìíîï]/g, 'i').replace(/[òóôõö]/g, 'o').replace(/[ùúûü]/g, 'u').replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function extractYear(dateStr) {
  if (!dateStr) return null;
  var m = String(dateStr).match(/(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

function getTmdbMetadata(tmdbId, mediaType) {
  var type = mediaType === 'tv' ? 'tv' : 'movie';
  var url = 'https://api.themoviedb.org/3/' + type + '/' + tmdbId + '?language=fr-FR&api_key=' + TMDB_KEY;
  return fetch(url).then(function(res) { return res.json(); }).then(function(data) {
      return { fr: data.title || data.name, orig: data.original_title || data.original_name, year: extractYear(data.release_date || data.first_air_date) };
  });
}

// ─── Search & Fetch ──────────────────────────────────────────

function findPurstreamIdByTitle(title, mediaType, tmdbYear) {
  var encoded = encodeURIComponent(title);
  return fetch(PURSTREAM_API + '/search-bar/search/' + encoded, { headers: { 'User-Agent': PURSTREAM_UA, 'Referer': PURSTREAM_REFERER, 'Origin': 'https://purstream.art' } })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      var items = data.data.items.movies && data.data.items.movies.items ? data.data.items.movies.items : [];
      if (items.length === 0) throw new Error();
      var cleanTarget = cleanTitle(title);
      var match = items.find(function(item) {
          var purYear = extractYear(item.release_date);
          return cleanTitle(item.title) === cleanTarget && (Math.abs(tmdbYear - purYear) <= 1 || !tmdbYear);
      }) || items[0];
      return match.id;
    });
}

function fetchMovieSources(purstreamId) {
  return fetch(PURSTREAM_API + '/media/' + purstreamId + '/sheet', { headers: { 'User-Agent': PURSTREAM_UA, 'Referer': PURSTREAM_REFERER } })
    .then(function(res) { return res.json(); }).then(function(data) { return data.data.items.urls || []; });
}

function fetchEpisodeSources(purstreamId, season, episode) {
  return fetch(PURSTREAM_API + '/stream/' + purstreamId + '/episode?season=' + (season || 1) + '&episode=' + (episode || 1), { headers: { 'User-Agent': PURSTREAM_UA, 'Referer': PURSTREAM_REFERER } })
    .then(function(res) { return res.json(); }).then(function(data) { return data.data.items.sources || []; });
}

// ─── Normalization ───────────────────────────────────────────

function parseLang(name) {
  var n = (name || '').toUpperCase();
  if (n.indexOf('VOSTFR') !== -1) return 'VOSTFR';
  if (n.indexOf('VF') !== -1) return 'VF';
  return 'MULTI';
}

function parseQuality(name) {
  var n = (name || '').toUpperCase();
  if (n.indexOf('4K') !== -1) return '4K';
  if (n.indexOf('1080') !== -1) return '1080p';
  if (n.indexOf('720') !== -1) return '720p';
  return 'HD';
}

function normalizeMovieSources(urls, englishName) {
  return urls.filter(function(item) { return item.url && (item.url.match(/\.m3u8/i) || item.url.match(/\.mp4/i)); })
    .map(function(item) {
      var q = parseQuality(item.name);
      return {
        name: 'Purstream - ' + q,
        title: buildPurstreamTitle(englishName, q, parseLang(item.name), item.url.match(/\.mp4/i) ? 'mp4' : 'm3u8', null, null, null),
        url: item.url,
        quality: q,
        format: item.url.match(/\.mp4/i) ? 'mp4' : 'm3u8',
        headers: { 'User-Agent': PURSTREAM_UA, 'Referer': PURSTREAM_REFERER }
      };
    });
}

function normalizeEpisodeSources(sources, englishName, season, episode, epName) {
  return sources.map(function(item) {
    var q = parseQuality(item.source_name);
    return {
      name: 'Purstream - ' + q,
      title: buildPurstreamTitle(englishName, q, parseLang(item.source_name), item.format || 'm3u8', season, episode, epName),
      url: item.stream_url,
      quality: q,
      format: item.format || 'm3u8',
      headers: { 'User-Agent': PURSTREAM_UA, 'Referer': PURSTREAM_REFERER }
    };
  });
}

// ─── Main ────────────────────────────────────────────────────

function getStreams(tmdbId, mediaType, season, episode) {
  return Promise.all([
    getEnglishTitle(tmdbId, mediaType),
    mediaType === 'tv' ? getEpisodeName(tmdbId, season, episode) : Promise.resolve(null),
    detectPurstreamDomain(),
    getTmdbMetadata(tmdbId, mediaType)
  ]).then(function(results) {
    var englishName = results[0];
    var epName      = results[1];
    var endpoint    = results[2];
    var meta        = results[3];
    applyPurstreamDomain(endpoint);

    return findPurstreamIdByTitle(meta.fr, mediaType, meta.year)
      .catch(function() { return findPurstreamIdByTitle(meta.orig, mediaType, meta.year); })
      .then(function(purstreamId) {
        if (mediaType === 'tv') {
          return fetchEpisodeSources(purstreamId, season, episode).then(function(s) { 
              return normalizeEpisodeSources(s, englishName, season, episode, epName); 
          });
        } else {
          return fetchMovieSources(purstreamId).then(function(u) { 
              return normalizeMovieSources(u, englishName); 
          });
        }
      });
  }).catch(function() { return []; });
}

if (typeof module !== 'undefined' && module.exports) module.exports = { getStreams };
else global.getStreams = getStreams;
