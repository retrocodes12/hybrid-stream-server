/**
 * cinestream - Built from src/cinestream/
 * Generated: 2026-05-05T11:44:45.763Z
 */
var __defProp = Object.defineProperty;
var __defProps = Object.defineProperties;
var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __spreadValues = (a, b) => {
  for (var prop in b || (b = {}))
    if (__hasOwnProp.call(b, prop))
      __defNormalProp(a, prop, b[prop]);
  if (__getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(b)) {
      if (__propIsEnum.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    }
  return a;
};
var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
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
var PLAYABLE_CHECK_TIMEOUT_MS = 7e3;
var PLAYABLE_EXTENSION_PATTERN = /\.(?:mp4|mkv|webm|m3u8)(?:[?#]|$)/i;
var HTML_WRAPPER_HOSTS = /* @__PURE__ */ new Set(["hubcdn.fans"]);
var HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json"
};
var DIRECT_FALLBACK_PROVIDERS = (mediaType) => mediaType === "tv" || mediaType === "series" ? ["./4khdhub.js", "./hdhub4u.js"] : [];
function detectQualityLabel(value) {
  const text = String(value || "");
  const match = text.match(/\b(2160p|4k|1440p|1080p|720p|480p|360p)\b/i);
  if (!match) return "Auto";
  const normalized = match[1].toLowerCase();
  return normalized === "4k" ? "2160p" : normalized;
}
function rewriteUpstreamLabel(value) {
  return String(value || "").replace(/WebStreamrMBG/gi, "NebulaStreams").replace(/\s+/g, " ").trim();
}
function normalizeStreamUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
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
function normalizeMediaType(mediaType) {
  const normalized = String(mediaType || "movie").trim().toLowerCase();
  return normalized === "series" ? "tv" : normalized;
}
function toStreamContentType(mediaType) {
  return normalizeMediaType(mediaType) === "tv" ? "series" : "movie";
}
function normalizeTitleKey(value) {
  return String(value || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");
}
function streamMatchesRequestedContent(stream, info) {
  const expectedTitle = normalizeTitleKey(info == null ? void 0 : info.title);
  if (!expectedTitle) return true;
  const streamTitle = normalizeTitleKey(`${(stream == null ? void 0 : stream.title) || ""} ${(stream == null ? void 0 : stream.name) || ""}`);
  if (!streamTitle) return true;
  return streamTitle.includes(expectedTitle) || expectedTitle.includes(streamTitle);
}
function isKnownHtmlWrapperUrl(value) {
  try {
    return HTML_WRAPPER_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch (e) {
    return false;
  }
}
function hasPlayableExtension(value) {
  return PLAYABLE_EXTENSION_PATTERN.test(String(value || ""));
}
function isApiBaseUrl(value) {
  try {
    return new URL(value).hostname.toLowerCase() === new URL(API_BASE).hostname.toLowerCase();
  } catch (e) {
    return false;
  }
}
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function fetchJsonWithRetry(_0) {
  return __async(this, arguments, function* (url, options = {}, attempts = 3) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const res = yield fetch(url, options);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return yield res.json();
      } catch (error) {
        lastError = error;
        if (attempt < attempts) {
          yield wait(250 * attempt);
        }
      }
    }
    throw lastError || new Error("Request failed");
  });
}
function resolvePlayableStream(stream) {
  return __async(this, null, function* () {
    var _a, _b;
    const url = normalizeStreamUrl(stream == null ? void 0 : stream.url);
    if (!url || isKnownHtmlWrapperUrl(url)) return null;
    if (hasPlayableExtension(url)) {
      return __spreadProps(__spreadValues({}, stream), { url });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PLAYABLE_CHECK_TIMEOUT_MS);
    try {
      const res = yield fetch(url, {
        headers: __spreadProps(__spreadValues({}, (stream == null ? void 0 : stream.headers) || {}), {
          Range: "bytes=0-1023"
        }),
        redirect: "follow",
        signal: controller.signal
      });
      const contentType = String(res.headers.get("content-type") || "").toLowerCase();
      const contentLength = Number.parseInt(res.headers.get("content-length") || "0", 10);
      const contentRange = String(res.headers.get("content-range") || "");
      const finalUrl = normalizeStreamUrl(res.url || url);
      yield (_b = (_a = res.body) == null ? void 0 : _a.cancel) == null ? void 0 : _b.call(_a);
      if (!res.ok && res.status !== 206) return null;
      if (contentType.includes("text/html")) return null;
      const videoLike = contentType.startsWith("video/") || contentType.includes("mpegurl") || contentType.includes("application/vnd.apple.mpegurl") || contentType.includes("application/octet-stream") && (hasPlayableExtension(finalUrl) || contentLength > 1048576) || Boolean(contentRange);
      return videoLike ? __spreadProps(__spreadValues({}, stream), { url: finalUrl }) : null;
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  });
}
function filterPlayableStreams(streams, info) {
  return __async(this, null, function* () {
    const output = [];
    const seen = /* @__PURE__ */ new Set();
    for (const stream of Array.isArray(streams) ? streams : []) {
      if (!streamMatchesRequestedContent(stream, info)) continue;
      const playable = yield resolvePlayableStream(stream);
      if (playable) {
        const key = normalizeStreamUrl(playable.url);
        if (seen.has(key)) continue;
        seen.add(key);
        output.push(playable);
      }
    }
    return output;
  });
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
        if (!res.ok) continue;
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
        if (!provider || typeof provider.getStreams !== "function") continue;
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
  const seen = /* @__PURE__ */ new Set();
  for (const stream of Array.isArray(streams) ? streams : []) {
    const key = JSON.stringify({
      url: String((stream == null ? void 0 : stream.url) || "").trim() || null,
      magnet: String((stream == null ? void 0 : stream.magnet) || (stream == null ? void 0 : stream.torrent) || "").trim() || null,
      quality: String((stream == null ? void 0 : stream.quality) || "").trim().toLowerCase() || null
    });
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(stream);
  }
  return output;
}
function getIMDBId(tmdbId, mediaType) {
  return __async(this, null, function* () {
    var _a;
    const normalizedMediaType = normalizeMediaType(mediaType);
    const url = `${TMDB_BASE_URL}/${normalizedMediaType}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;
    const data = yield fetchJsonWithRetry(url, { headers: { "Accept": "application/json" } });
    return {
      imdbId: (_a = data.external_ids) == null ? void 0 : _a.imdb_id,
      title: normalizedMediaType === "tv" ? data.name : data.title,
      year: String((normalizedMediaType === "tv" ? data.first_air_date : data.release_date) || "").slice(0, 4)
    };
  });
}
function getStreams(tmdbId, mediaType = "movie", season = null, episode = null) {
  return __async(this, null, function* () {
    try {
      const normalizedMediaType = normalizeMediaType(mediaType);
      const streamContentType = toStreamContentType(normalizedMediaType);
      let info = null;
      try {
        info = yield getIMDBId(tmdbId, normalizedMediaType);
      } catch (error) {
        console.log(`[CineStream] TMDB lookup failed: ${error.message}`);
      }
      let urls = [];
      if (normalizedMediaType === "movie" && (info == null ? void 0 : info.title)) {
        urls = [
          ...(info == null ? void 0 : info.imdbId) ? [`${API_BASE}/stream/movie/${info.imdbId}.json`] : [],
          `${API_BASE}/stream/movie/tmdb:${tmdbId}.json`
        ];
      } else if (info == null ? void 0 : info.imdbId) {
        urls = buildSeriesCandidateUrls(API_BASE, info.imdbId, tmdbId, season, episode);
      } else if (normalizedMediaType !== "movie") {
        urls = [`${API_BASE}/stream/${streamContentType}/tmdb:${tmdbId}:${Number(season) || 0}:${Number(episode) || 0}.json`];
      }
      const data = urls.length > 0 ? yield fetchFirstWorkingPayload(urls) : null;
      const upstreamStreams = (data == null ? void 0 : data.streams) || [];
      const directFallbackStreams = yield fetchDirectFallbackStreams(tmdbId, normalizedMediaType, season, episode);
      const streams = yield filterPlayableStreams(
        dedupeStreams([...upstreamStreams, ...directFallbackStreams]).filter((s) => normalizeStreamUrl(s == null ? void 0 : s.url)),
        info
      );
      if (streams.length === 0) return [];
      return streams.map((s) => {
        var _a, _b;
        const quality = detectQualityLabel(`${s.name || ""} ${s.title || ""}`);
        const upstreamName = rewriteUpstreamLabel(s.name || "");
        const fallbackName = quality === "Auto" ? "NebulaStreams" : `NebulaStreams ${quality}`;
        const title = String(s.title || s.name || fallbackName);
        const requestHeaders = isApiBaseUrl(s.url) ? s.headers || ((_b = (_a = s.behaviorHints) == null ? void 0 : _a.proxyHeaders) == null ? void 0 : _b.request) || { "Referer": API_BASE } : null;
        return {
          name: `CS [${upstreamName || fallbackName}]`,
          title: rewriteUpstreamLabel(title.split("\n")[0]),
          url: normalizeStreamUrl(s.url),
          quality,
          headers: requestHeaders
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
