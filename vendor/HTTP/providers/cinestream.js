/**
 * cinestream - Built from src/cinestream/
 * Generated: 2026-04-03T00:33:53.557Z
 */
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

// src/cinestream/index.js
var TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c";
var TMDB_BASE_URL = "https://api.themoviedb.org/3";
var API_BASE = "https://87d6a6ef6b58-webstreamrmbg.baby-beamup.club";
var HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json"
};
var DIRECT_FALLBACK_PROVIDERS = (mediaType) => mediaType === "tv" ? ["./4khdhub.js", "./hdhub4u.js"] : [];
function detectQualityLabel(value) {
  const text = String(value || "");
  const match = text.match(/\b(2160p|4k|1440p|1080p|720p|480p|360p)\b/i);
  if (!match)
    return "Auto";
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
  const raw = String(value || "").trim();
  if (!raw)
    return "";
  try {
    const parsedUrl = new URL(raw);
    const apiBaseUrl = new URL(API_BASE);
    if (parsedUrl.hostname === "87d6a6ef6b58-webstreamrmbg") {
      parsedUrl.hostname = apiBaseUrl.hostname;
    }
    return parsedUrl.toString();
  } catch (error) {
    return raw;
  }
}
function pad2(value) {
  return String(Number(value) || 0).padStart(2, "0");
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
  for (const route of ["series", "tv"]) {
    for (const id of ids) {
      candidates.push(`${apiBase}/stream/${route}/${id}.json`);
    }
  }
  return candidates;
}
function fetchFirstWorkingPayload(urls) {
  return __async(this, null, function* () {
    for (const url of urls) {
      console.log(`[CineStream] Fetching: ${url}`);
      try {
        const res = yield fetch(url, { headers: HEADERS });
        if (!res.ok)
          continue;
        const data = yield res.json();
        if (Array.isArray(data == null ? void 0 : data.streams) && data.streams.length > 0) {
          return data;
        }
      } catch (error) {
        console.log(`[CineStream] Candidate failed: ${error.message}`);
      }
    }
    return null;
  });
}
function fetchDirectFallbackStreams(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    const fallbackStreams = [];
    for (const modulePath of DIRECT_FALLBACK_PROVIDERS(mediaType)) {
      try {
        const provider = require(modulePath);
        if (!provider || typeof provider.getStreams !== "function")
          continue;
        const streams = yield provider.getStreams(tmdbId, mediaType, season, episode);
        if (Array.isArray(streams) && streams.length > 0) {
          fallbackStreams.push(...streams);
        }
      } catch (error) {
        console.log(`[CineStream] Direct fallback failed for ${modulePath}: ${error.message}`);
      }
    }
    return fallbackStreams;
  });
}
function dedupeStreams(streams) {
  const output = [];
  const seen = new Set();
  for (const stream of Array.isArray(streams) ? streams : []) {
    const key = JSON.stringify({
      url: String((stream == null ? void 0 : stream.url) || "").trim() || null,
      magnet: String((stream == null ? void 0 : stream.magnet) || (stream == null ? void 0 : stream.torrent) || "").trim() || null,
      quality: String((stream == null ? void 0 : stream.quality) || "").trim().toLowerCase() || null
    });
    if (seen.has(key))
      continue;
    seen.add(key);
    output.push(stream);
  }
  return output;
}
function getIMDBId(tmdbId, mediaType) {
  return __async(this, null, function* () {
    var _a;
    const url = `${TMDB_BASE_URL}/${mediaType}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;
    const res = yield fetch(url, { headers: { "Accept": "application/json" } });
    const data = yield res.json();
    return {
      imdbId: (_a = data.external_ids) == null ? void 0 : _a.imdb_id,
      title: mediaType === "tv" ? data.name : data.title
    };
  });
}
function getStreams(tmdbId, mediaType = "movie", season = null, episode = null) {
  return __async(this, null, function* () {
    try {
      let info = null;
      try {
        info = yield getIMDBId(tmdbId, mediaType);
      } catch (error) {
        console.log(`[CineStream] TMDB lookup failed: ${error.message}`);
      }
      let urls = [];
      if ((info == null ? void 0 : info.imdbId) && mediaType === "movie") {
        urls = [`${API_BASE}/stream/movie/${info.imdbId}.json`];
      } else if (info == null ? void 0 : info.imdbId) {
        urls = buildSeriesCandidateUrls(API_BASE, info.imdbId, tmdbId, season, episode);
      }
      const data = urls.length > 0 ? yield fetchFirstWorkingPayload(urls) : null;
      const upstreamStreams = (data == null ? void 0 : data.streams) || [];
      const directFallbackStreams = yield fetchDirectFallbackStreams(tmdbId, mediaType, season, episode);
      const streams = dedupeStreams([...upstreamStreams, ...directFallbackStreams]);
      if (streams.length === 0)
        return [];
      return streams.map((s) => {
        var _a, _b;
        const quality = detectQualityLabel(`${s.name || ""} ${s.title || ""}`);
        const upstreamName = rewriteUpstreamLabel(s.name || "");
        const fallbackName = quality === "Auto" ? "NebulaStreams" : `NebulaStreams ${quality}`;
        return {
          name: `CS [${upstreamName || fallbackName}]`,
          title: rewriteUpstreamLabel(s.title.split("\n")[0]),
          url: normalizeStreamUrl(s.url),
          quality,
          headers: ((_b = (_a = s.behaviorHints) == null ? void 0 : _a.proxyHeaders) == null ? void 0 : _b.request) || { "Referer": API_BASE }
        };
      });
    } catch (e) {
      console.error("[CineStream] Error:", e.message);
      return [];
    }
  });
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = { getStreams };
}
