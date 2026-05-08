/**
 * brazucaplay - Built from src/brazucaplay/
 * Updated: 2026-05-01 (Added Superflix, Overflix, VisãoCine + English/PT Support)
 */
var __defProp = Object.defineProperty;
var __defProps = Object.defineProperties;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => { try { step(generator.next(value)); } catch (e) { reject(e); } };
    var rejected = (value) => { try { step(generator.throw(value)); } catch (e) { reject(e); } };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

// src/utils/http.js
var require_http = __commonJS({
  "src/utils/http.js"(exports2, module2) {
    var sessionUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    function setSessionUA(ua) { sessionUA = ua; }
    function getSessionUA() { return sessionUA; }
    function request(url, options) {
      return __async(this, null, function* () {
        var opt = options || {};
        var headers = Object.assign({ "User-Agent": getSessionUA(), "Accept": "*/*" }, opt.headers);
        return yield fetch(url, Object.assign({ redirect: "follow" }, opt, { headers }));
      });
    }
    module2.exports = { request, setSessionUA, getSessionUA, fetchJson: (url, opt) => request(url, opt).then(r => r.json()) };
  }
});

// src/utils/sorting.js
var sorting_exports = {};
__export(sorting_exports, { sortStreamsByQuality: () => sortStreamsByQuality });
function sortStreamsByQuality(streams) {
  const Q = { "4K": 100, "1080p": 80, "720p": 70, "480p": 60, "360p": 50 };
  return [...streams].sort((a, b) => (Q[b.quality] || 0) - (Q[a.quality] || 0));
}
var init_sorting = __esm({ "src/utils/sorting.js"() {} });

// src/utils/engine.js
var require_engine = __commonJS({
  "src/utils/engine.js"(exports2, module2) {
    var { sortStreamsByQuality: sortSQ } = (init_sorting(), __toCommonJS(sorting_exports));
    
    function normalizeLanguage(lang) {
      const l = (lang || "").toLowerCase();
      if (l.includes("lat") || l.includes("esp") || l.includes("mex")) return "Latino";
      if (l.includes("por") || l.includes("bra") || l.includes("pt")) return "Português";
      if (l.includes("eng") || l.includes("en-us") || l === "en" || l.includes("original")) return "Inglés";
      if (l.includes("sub") || l.includes("vose")) return "Subtitulado";
      return "Latino";
    }

    function finalizeStreams2(streams, providerName) {
      return __async(this, null, function* () {
        if (!Array.isArray(streams)) return [];
        const sorted = sortSQ(streams);
        const processed = [];
        for (const s of sorted) {
          const rawLang = normalizeLanguage(s.audio || s.lang || "Latino");
          const l = rawLang.toLowerCase();
          
          // ALLOWED: Latino, Spanish, English, and Portuguese
          const isAllowed = l.includes("latino") || l.includes("español") || l.includes("inglés") || l.includes("english") || l.includes("português");
          if (!isAllowed) continue;

          processed.push({
            name: `${providerName} - ${s.quality || "HD"}`,
            title: `${rawLang} - ${s.serverName || "Server"}`,
            url: s.url,
            quality: s.quality || "HD",
            language: rawLang,
            headers: s.headers
          });
        }
        return processed;
      });
    }
    module2.exports = { finalizeStreams: finalizeStreams2 };
  }
});

// src/brazucaplay/index.js
var { fetchJson, setSessionUA, request } = require_http();
var { finalizeStreams } = require_engine();
var API_DEC = "https://enc-dec.app/api/dec-videasy";
var TMDB_API_KEY = "d131017ccc6e5462a81c9304d21476de";
var TMDB_BASE_URL = "https://api.themoviedb.org/3";

var SERVERS = {
  "Gekko": { url: "https://api2.videasy.net/cuevana/sources-with-title", label: "Cuevana", lang: "Latino" },
  "Superflix": { url: "https://api.videasy.net/superflix/sources-with-title", label: "Superflix", lang: "Português" },
  "Overflix": { url: "https://api2.videasy.net/overflix/sources-with-title", label: "Overflix", lang: "Português" },
  "VisãoCine": { url: "https://api.videasy.net/visioncine/sources-with-title", label: "VisãoCine", lang: "Português" }
};

var COMMON_HEADERS = {
  "Accept": "*/*",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
};

function getStreams(tmdbId, mediaType = "movie", season = null, episode = null) {
  return __async(this, null, function* () {
    try {
      const tmdbUrl = `${TMDB_BASE_URL}/${mediaType === "tv" ? "tv" : "movie"}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;
      const tmdbData = yield fetchJson(tmdbUrl);
      const title = tmdbData.title || tmdbData.name;
      const year = (tmdbData.release_date || tmdbData.first_air_date || "").split("-")[0];
      const doubleEncTitle = encodeURIComponent(encodeURIComponent(title));
      const imdbId = tmdbData.external_ids?.imdb_id || "";

      const serverPromises = Object.entries(SERVERS).map(([id, config]) => __async(this, null, function* () {
        try {
          let searchUrl = `${config.url}?title=${doubleEncTitle}&mediaType=${mediaType === "tv" ? "tv" : "movie"}&year=${year}&tmdbId=${tmdbId}&imdbId=${imdbId}`;
          if (mediaType === "tv") searchUrl += `&episodeId=${episode || 1}&seasonId=${season || 1}`;

          const encryptedRes = yield request(searchUrl, { headers: COMMON_HEADERS });
          const encryptedText = yield encryptedRes.text();
          if (!encryptedText || encryptedText.length < 20) return [];

          const decRes = yield request(API_DEC, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: encryptedText, id: String(tmdbId) })
          });
          const decData = yield decRes.json();
          const mediaData = decData.result || decData;

          const results = [];
          if (mediaData && mediaData.sources) {
            for (const source of mediaData.sources) {
              if (source.url) {
                // If the source has English/Original audio, we prioritize that label
                let audio = source.audio || source.language || config.lang;
                
                results.push({
                  serverName: config.label,
                  audio: audio,
                  quality: (source.quality || "1080p").toUpperCase(),
                  url: source.url,
                  headers: COMMON_HEADERS
                });
              }
            }
          }
          return results;
        } catch (e) { return []; }
      }));

      const allResults = yield Promise.all(serverPromises);
      return yield finalizeStreams(allResults.flat(), "BrazucaPlay");
    } catch (error) { return []; }
  });
}

module.exports = { getStreams };
