// ShowBox Scraper for Nuvio Local Scrapers
// React Native compatible version - Promise-based approach only

// TMDB API Configuration
const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

// ShowBox API Configuration
const CryptoJS = require('crypto-js');
const axios = require('axios');
const SHOWBOX_DIRECT_API_BASE = 'https://mbpapi.shegu.net/api/api_client/index/';
const SHOWBOX_DIRECT_APP_KEY = 'moviebox';
const SHOWBOX_DIRECT_APP_ID = 'com.tdo.showbox';
const SHOWBOX_DIRECT_KEY = '123d6cedf626dy54233aa1w6';
const SHOWBOX_DIRECT_IV = 'wEiphTn!';
const FEBBOX_SHARE_ID_API = (function () {
    try {
        const configured = typeof process !== 'undefined' && process.env
            ? String(process.env.FEBBOX_SHARE_ID_API || '').trim().replace(/\/+$/g, '')
            : '';
        return configured || 'https://febox.vercel.app/api/febbox/id';
    } catch (e) {
        return 'https://febox.vercel.app/api/febbox/id';
    }
})();
const SHOWBOX_API_BASE = (function () {
    try {
        const configured = typeof process !== 'undefined' && process.env
            ? String(process.env.SHOWBOX_API_BASE || '').trim().replace(/\/+$/g, '')
            : '';
        return configured || 'https://febapi.nuvioapp.space/api';
    } catch (e) {
        return 'https://febapi.nuvioapp.space/api';
    }
})();
const SHOWBOX_API_BASES = (function () {
    try {
        const raw = typeof process !== 'undefined' && process.env
            ? String(process.env.SHOWBOX_API_BASES || '').trim()
            : '';
        const configured = raw
            ? raw.split(',').map(function (value) { return value.trim().replace(/\/+$/g, ''); }).filter(Boolean)
            : [];
        return configured.length ? configured : [SHOWBOX_API_BASE];
    } catch (e) {
        return [SHOWBOX_API_BASE];
    }
})();
const TMDB_REQUEST_TIMEOUT_MS = 8000;
const SHOWBOX_API_TIMEOUT_MS = 18000;
const SHOWBOX_LEGACY_API_TIMEOUT_MS = 8000;

// Working headers for ShowBox API
const WORKING_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Content-Type': 'application/json'
};
const SHOWBOX_PLAYBACK_HEADERS = {
    'User-Agent': WORKING_HEADERS['User-Agent'],
    'Accept': '*/*',
    'Referer': 'https://www.febbox.com/',
    'Origin': 'https://www.febbox.com'
};

function getEnvString(name) {
    try {
        if (typeof process !== 'undefined' && process.env && process.env[name]) {
            return String(process.env[name]).trim();
        }
    } catch (e) {
        // ignore and fall through
    }
    return '';
}

function redactSensitiveUrl(value) {
    try {
        const parsed = new URL(String(value || ''));
        ['cookie', 'token', 'uiToken', 'showbox', 'ui'].forEach(function (key) {
            if (parsed.searchParams.has(key)) {
                parsed.searchParams.set(key, 'REDACTED');
            }
        });
        return parsed.toString();
    } catch (e) {
        return String(value || '').replace(/([?&;\s](?:cookie|token|uiToken|showbox|ui)=)[^&;\s]+/gi, '$1REDACTED');
    }
}

function normalizeUiToken(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';

    const cookieLikeMatch = raw.match(/(?:^|[;\s])(uiToken|showbox|token|ui)=([^;]+)/i);
    if (cookieLikeMatch && cookieLikeMatch[2]) {
        return decodeURIComponent(cookieLikeMatch[2].trim());
    }

    const jwtLikeMatch = raw.match(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    if (jwtLikeMatch) {
        return jwtLikeMatch[0];
    }

    return raw;
}

// UI token (cookie) is provided by the host app via per-scraper settings (Plugin Screen)
function getUiToken(scraperSettings = null) {
    if (scraperSettings && scraperSettings.uiToken) {
        return normalizeUiToken(scraperSettings.uiToken);
    }

    try {
        // Prefer sandbox-injected globals
        if (typeof global !== 'undefined' && global.SCRAPER_SETTINGS && global.SCRAPER_SETTINGS.uiToken) {
            return normalizeUiToken(global.SCRAPER_SETTINGS.uiToken);
        }
        if (typeof window !== 'undefined' && window.SCRAPER_SETTINGS && window.SCRAPER_SETTINGS.uiToken) {
            return normalizeUiToken(window.SCRAPER_SETTINGS.uiToken);
        }
    } catch (e) {
        // ignore and fall through
    }
    const envToken = getEnvString('SHOWBOX_UI_TOKEN') || getEnvString('SHOWBOX_COOKIE');
    if (envToken) {
        return normalizeUiToken(envToken);
    }
    return '';
}

// OSS Group is provided by the host app via per-scraper settings (Plugin Screen) - optional
function getOssGroup(scraperSettings = null) {
    if (scraperSettings && scraperSettings.ossGroup) {
        return String(scraperSettings.ossGroup).trim();
    }

    try {
        // Prefer sandbox-injected globals
        if (typeof global !== 'undefined' && global.SCRAPER_SETTINGS && global.SCRAPER_SETTINGS.ossGroup) {
            return String(global.SCRAPER_SETTINGS.ossGroup);
        }
        if (typeof window !== 'undefined' && window.SCRAPER_SETTINGS && window.SCRAPER_SETTINGS.ossGroup) {
            return String(window.SCRAPER_SETTINGS.ossGroup);
        }
    } catch (e) {
        // ignore and fall through
    }
    const envOssGroup = getEnvString('SHOWBOX_OSS_GROUP');
    if (envOssGroup) {
        return envOssGroup;
    }
    return null; // OSS group is optional
}

function decodeBase64Url(value) {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);

    if (typeof atob === 'function') {
        return decodeURIComponent(Array.prototype.map.call(atob(padded), function (char) {
            return '%' + ('00' + char.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
    }

    if (typeof Buffer !== 'undefined' && Buffer.from) {
        return Buffer.from(padded, 'base64').toString('utf8');
    }

    throw new Error('No base64 decoder available');
}

function getJwtExpiryIso(token) {
    try {
        const payloadSegment = String(token || '').split('.')[1];

        if (!payloadSegment) {
            return 'unknown';
        }

        const payload = JSON.parse(decodeBase64Url(payloadSegment));

        if (!payload || typeof payload.exp !== 'number') {
            return 'unknown';
        }

        return new Date(payload.exp * 1000).toISOString();
    } catch (error) {
        return 'unknown';
    }
}

// Utility Functions
function getQualityFromName(qualityStr) {
    if (!qualityStr) return 'Unknown';

    const quality = qualityStr.toUpperCase();

    // Map API quality values to normalized format
    if (quality === 'ORG' || quality === 'ORIGINAL') return 'Original';
    if (quality === '4K' || quality === '2160P') return '4K';
    if (quality === '1440P' || quality === '2K') return '1440p';
    if (quality === '1080P' || quality === 'FHD') return '1080p';
    if (quality === '720P' || quality === 'HD') return '720p';
    if (quality === '480P' || quality === 'SD') return '480p';
    if (quality === '360P') return '360p';
    if (quality === '240P') return '240p';

    // Try to extract explicit resolution from filenames/labels first.
    let match = qualityStr.match(/(\d{3,4})[pP]\b/i);
    if (!match && /^\s*\d{3,4}\s*$/u.test(qualityStr)) {
        match = qualityStr.match(/(\d{3,4})/);
    }
    if (match) {
        const resolution = parseInt(match[1]);
        if (resolution >= 2160) return '4K';
        if (resolution >= 1440) return '1440p';
        if (resolution >= 1080) return '1080p';
        if (resolution >= 720) return '720p';
        if (resolution >= 480) return '480p';
        if (resolution >= 360) return '360p';
        return '240p';
    }

    return 'Unknown';
}

function parseSizeBytes(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const match = String(value || '').match(/([0-9]+(?:\.[0-9]+)?)\s*(TB|GB|MB|KB)/i);
    if (!match) return 0;
    const amount = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    const multipliers = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
    return amount * (multipliers[unit] || 0);
}

function getQualityFromSize(value) {
    const bytes = parseSizeBytes(value);
    if (!bytes) return 'Unknown';
    const gb = bytes / (1024 ** 3);
    if (gb >= 14) return '4K';
    if (gb >= 3) return '1080p';
    if (gb >= 1) return '720p';
    if (gb >= 0.35) return '480p';
    return '360p';
}

function getBestQuality() {
    const values = Array.prototype.slice.call(arguments);
    for (const value of values) {
        const quality = getQualityFromName(value);
        if (quality !== 'Unknown') return quality;
    }
    return getQualityFromSize(values.find(value => parseSizeBytes(value)) || '');
}

function md5(value) {
    return CryptoJS.MD5(String(value || '')).toString();
}

function randomToken(length) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let output = '';
    for (let i = 0; i < length; i += 1) {
        output += chars[Math.floor(Math.random() * chars.length)];
    }
    return output;
}

function encryptShowBoxPayload(message) {
    const encrypted = CryptoJS.TripleDES.encrypt(
        String(message),
        CryptoJS.enc.Utf8.parse(SHOWBOX_DIRECT_KEY),
        {
            iv: CryptoJS.enc.Utf8.parse(SHOWBOX_DIRECT_IV),
            mode: CryptoJS.mode.CBC,
            padding: CryptoJS.pad.Pkcs7
        }
    );

    return encrypted.ciphertext.toString(CryptoJS.enc.Base64);
}

function buildShowBoxDirectBody(params) {
    const query = JSON.stringify({
        appid: SHOWBOX_DIRECT_APP_ID,
        expired_date: Math.floor(Date.now() / 1000) + (60 * 60 * 12),
        platform: 'android',
        app_version: '11.5',
        channel: 'Website',
        childmode: 0,
        lang: 'en',
        pagelimit: 10,
        ...params
    });
    const encryptedQuery = encryptShowBoxPayload(query);
    const body = {
        app_key: md5(SHOWBOX_DIRECT_APP_KEY),
        verify: md5(md5(SHOWBOX_DIRECT_APP_KEY) + SHOWBOX_DIRECT_KEY + encryptedQuery),
        encrypt_data: encryptedQuery
    };

    return new URLSearchParams({
        data: Buffer.from(JSON.stringify(body), 'utf8').toString('base64'),
        appid: '27',
        platform: 'android',
        version: '129',
        medium: 'Website&token' + randomToken(32)
    });
}

function showBoxDirectRequest(params) {
    return makeRequest(SHOWBOX_DIRECT_API_BASE, {
        method: 'POST',
        timeoutMs: 12000,
        headers: {
            Platform: 'android',
            Accept: 'charset=utf-8',
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: buildShowBoxDirectBody(params)
    }).then(function (response) {
        return response.json();
    });
}

function normalizeTitle(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function pickShowBoxSearchResult(results, mediaInfo, mediaType) {
    const list = Array.isArray(results) ? results : [];
    const wantedTitle = normalizeTitle(mediaInfo.title);
    const wantedYear = mediaInfo.year ? Number(mediaInfo.year) : null;
    const wantedBoxType = mediaType === 'tv' ? 2 : 1;

    return list
        .map(function (item) {
            const titleScore = normalizeTitle(item.title) === wantedTitle ? 100 : 0;
            const yearScore = wantedYear && Number(item.year) === wantedYear ? 25 : 0;
            const typeScore = Number(item.box_type) === wantedBoxType ? 50 : 0;
            return { item, score: titleScore + yearScore + typeScore };
        })
        .sort(function (a, b) { return b.score - a.score; })[0]?.item || null;
}

function getFebBoxShareKey(showboxId, boxType) {
    const url = `${FEBBOX_SHARE_ID_API}?id=${encodeURIComponent(showboxId)}&type=${encodeURIComponent(boxType)}`;
    return makeRequest(url, { timeoutMs: 12000 })
        .then(function (response) { return response.json(); })
        .then(function (data) { return data?.febBoxId || data?.shareKey || data?.share_key || null; });
}

function getFebBoxJson(url) {
    return axios.get(url, {
        timeout: 12000,
        headers: {
            Accept: 'application/json',
            'User-Agent': 'curl/8.5.0'
        },
        maxRedirects: 3
    }).then(function (response) {
        return response.data;
    });
}

function getFebBoxFileList(shareKey, parentId = 0) {
    const url = `https://www.febbox.com/file/file_share_list?share_key=${encodeURIComponent(shareKey)}&parent_id=${encodeURIComponent(parentId)}`;
    return getFebBoxJson(url)
        .then(function (data) { return data?.data?.file_list || []; });
}

function getFebBoxDownloadLinks(shareKey, fid) {
    const url = `https://www.febbox.com/file/file_download?fid=${encodeURIComponent(fid)}&share_key=${encodeURIComponent(shareKey)}`;
    return getFebBoxJson(url)
        .then(function (data) { return Array.isArray(data?.data) ? data.data : []; });
}

function isVideoFile(file) {
    return !file?.is_dir && /\.(mkv|mp4|webm|avi|mov)$/i.test(String(file?.file_name || file?.name || ''));
}

function findEpisodeFile(files, seasonNum, episodeNum) {
    const pattern = new RegExp(`s0*${Number(seasonNum)}e0*${Number(episodeNum)}\\b`, 'i');
    return files.find(function (file) { return pattern.test(String(file.file_name || '')); }) || null;
}

async function getCandidateFebBoxFiles(shareKey, mediaType, seasonNum, episodeNum) {
    const rootFiles = await getFebBoxFileList(shareKey, 0);

    if (mediaType !== 'tv') {
        return rootFiles.filter(isVideoFile);
    }

    const directEpisode = findEpisodeFile(rootFiles, seasonNum, episodeNum);
    if (directEpisode) return [directEpisode];

    const seasonPattern = new RegExp(`season\\s*0*${Number(seasonNum)}\\b|s0*${Number(seasonNum)}\\b`, 'i');
    const seasonDirs = rootFiles.filter(function (file) {
        return file?.is_dir && seasonPattern.test(String(file.file_name || ''));
    });
    const dirsToCheck = seasonDirs.length ? seasonDirs : rootFiles.filter(function (file) { return file?.is_dir; });

    for (const dir of dirsToCheck) {
        const files = await getFebBoxFileList(shareKey, dir.fid);
        const episodeFile = findEpisodeFile(files, seasonNum, episodeNum);
        if (episodeFile) return [episodeFile];
    }

    return [];
}

function buildStreamsFromFebBoxDownloads(downloads, mediaInfo, file, versionIndex) {
    const output = [];
    const baseTitle = mediaInfo.title || file.file_name || 'ShowBox';
    const fileName = file.file_name || file.name || baseTitle;
    const entries = [];

    downloads.forEach(function (download) {
        const hasQualityList = Array.isArray(download?.quality_list) && download.quality_list.length > 0;
        if (download?.download_url && !hasQualityList) {
            entries.push({
                quality: download.quality || download.quality_tag || file.quality || file.ext || 'Original',
                url: download.download_url,
                size: download.file_size || file.file_size || file.file_size_bytes,
                fileName: download.file_name || fileName
            });
        }
        if (hasQualityList) {
            download.quality_list.forEach(function (qualityEntry) {
                if (qualityEntry?.download_url) {
                    entries.push({
                        quality: qualityEntry.quality || download.quality || 'Original',
                        url: qualityEntry.download_url,
                        size: qualityEntry.file_size || download.file_size || file.file_size || file.file_size_bytes,
                        fileName: qualityEntry.file_name || download.file_name || fileName
                    });
                }
            });
        }
    });

    entries.forEach(function (entry) {
        const quality = getBestQuality(entry.fileName, entry.quality, entry.url, entry.size);
        output.push({
            name: `ShowBox ${quality}`,
            title: `${baseTitle}${mediaInfo.year ? ` (${mediaInfo.year})` : ''}`,
            url: entry.url,
            quality,
            size: formatFileSize(entry.size),
            filename: entry.fileName,
            headers: getShowBoxPlaybackHeaders(entry.url),
            provider: 'showbox',
            behaviorHints: {
                bingeGroup: `showbox-${versionIndex}`,
                notWebReady: true
            }
        });
    });

    return output;
}

async function getShowBoxDirectStreams(mediaInfo, mediaType, seasonNum, episodeNum) {
    const searchType = mediaType === 'tv' ? 'tv' : 'movie';
    const searchResponse = await showBoxDirectRequest({
        module: 'Search5',
        page: 1,
        pagelimit: 10,
        type: searchType,
        keyword: mediaInfo.title
    });
    const match = pickShowBoxSearchResult(searchResponse?.data, mediaInfo, mediaType);

    if (!match?.id || !match?.box_type) {
        console.log('[ShowBox] Direct search found no matching ShowBox item');
        return [];
    }

    const shareKey = await getFebBoxShareKey(match.id, match.box_type);
    if (!shareKey) {
        console.log('[ShowBox] Direct lookup found no FebBox share key');
        return [];
    }

    const files = await getCandidateFebBoxFiles(shareKey, mediaType, seasonNum, episodeNum);
    const streams = [];

    for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const downloads = await getFebBoxDownloadLinks(shareKey, file.fid);
        streams.push(...buildStreamsFromFebBoxDownloads(downloads, mediaInfo, file, index + 1));
    }

    console.log(`[ShowBox] Direct path returned ${streams.length} stream(s)`);
    return streams;
}

function formatFileSize(sizeStr) {
    if (!sizeStr) return 'Unknown';

    // If it's already formatted (like "15.44 GB" or "224.39 MB"), return as is
    if (typeof sizeStr === 'string' && (sizeStr.includes('GB') || sizeStr.includes('MB') || sizeStr.includes('KB'))) {
        return sizeStr;
    }

    // If it's a number, convert to GB/MB
    if (typeof sizeStr === 'number') {
        const gb = sizeStr / (1024 * 1024 * 1024);
        if (gb >= 1) {
            return `${gb.toFixed(2)} GB`;
        } else {
            const mb = sizeStr / (1024 * 1024);
            return `${mb.toFixed(2)} MB`;
        }
    }

    return sizeStr;
}

function getShowBoxPlaybackHeaders(streamUrl) {
    const headers = { ...SHOWBOX_PLAYBACK_HEADERS };

    try {
        const hostname = new URL(String(streamUrl || '')).hostname.toLowerCase();
        if (!hostname.includes('febbox') && !hostname.includes('showbox') && !hostname.includes('mbed')) {
            delete headers.Origin;
        }
    } catch (e) {
        delete headers.Origin;
    }

    return headers;
}

// Helper function to make HTTP requests
function makeRequest(url, options = {}) {
    const controller = new AbortController();
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : SHOWBOX_API_TIMEOUT_MS;
    const timeoutId = setTimeout(function () {
        controller.abort(new Error(`Request timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const requestOptions = { ...options };
    delete requestOptions.timeoutMs;

    return fetch(url, {
        method: requestOptions.method || 'GET',
        headers: { ...WORKING_HEADERS, ...requestOptions.headers },
        ...requestOptions,
        signal: requestOptions.signal || controller.signal
    }).then(function (response) {
        clearTimeout(timeoutId);
        if (!response.ok) {
            // Try to get response body for better error logging
            return response.text().then(function (body) {
                console.error(`[ShowBox] HTTP Error ${response.status}: ${response.statusText}`);
                console.error(`[ShowBox] Response body: ${body.substring(0, 500)}`);
                throw new Error(`HTTP ${response.status}: ${response.statusText} - ${body.substring(0, 200)}`);
            }).catch(function (parseError) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            });
        }
        return response;
    }).catch(function (error) {
        clearTimeout(timeoutId);
        console.error(`[ShowBox] Request failed for ${redactSensitiveUrl(url)}: ${error.message}`);
        throw error;
    });
}

// Simple in-memory cache for TMDB metadata
const tmdbCache = new Map();
const TMDB_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Get movie/TV show details from TMDB
function getTMDBDetails(tmdbId, mediaType) {
    const cacheKey = `${mediaType}:${tmdbId}`;
    const cached = tmdbCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
        console.log(`[ShowBox] TMDB cache hit for ${cacheKey}`);
        return Promise.resolve(cached.value);
    }

    const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
    const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;

    const fetchTmdb = async function () {
        let lastError = null;

        for (let attempt = 1; attempt <= 4; attempt += 1) {
            const controller = new AbortController();
            const timeoutId = setTimeout(function () {
                controller.abort(new Error(`TMDB request timeout after ${TMDB_REQUEST_TIMEOUT_MS}ms`));
            }, TMDB_REQUEST_TIMEOUT_MS);

            try {
                const response = await fetch(url, {
                    headers: { Accept: 'application/json', 'User-Agent': WORKING_HEADERS['User-Agent'] },
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                if (!response.ok) {
                    throw new Error(`TMDB HTTP ${response.status}`);
                }

                return { data: await response.json() };
            } catch (error) {
                clearTimeout(timeoutId);
                lastError = error;

                if (attempt < 4) {
                    await wait(250 * attempt);
                }
            }
        }

        throw lastError || new Error('TMDB lookup failed');
    };

    return fetchTmdb()
        .then(function (data) {
            data = data.data;
            const title = mediaType === 'tv' ? data.name : data.title;
            const releaseDate = mediaType === 'tv' ? data.first_air_date : data.release_date;
            const year = releaseDate ? parseInt(releaseDate.split('-')[0]) : null;

            const result = {
                title: title,
                year: year
            };

            tmdbCache.set(cacheKey, { value: result, expiresAt: Date.now() + TMDB_CACHE_TTL_MS });

            // Prune cache if it grows too large
            if (tmdbCache.size > 1000) {
                const now = Date.now();
                for (const [key, entry] of tmdbCache) {
                    if (entry.expiresAt <= now) {
                        tmdbCache.delete(key);
                    }
                }
            }

            return result;
        })
        .catch(function (error) {
            console.log(`[ShowBox] TMDB lookup failed: ${error.message}`);
            return {
                title: `TMDB ID ${tmdbId}`,
                year: null
            };
        });
}

// Process ShowBox API response - new format with versions and links
function processShowBoxResponse(data, mediaInfo, mediaType, seasonNum, episodeNum) {
    const streams = [];

    try {
        // Log full response for debugging
        console.log(`[ShowBox] API Response: ${JSON.stringify(data, null, 2).substring(0, 1000)}`);

        if (!data) {
            console.error(`[ShowBox] API returned empty/null response`);
            return streams;
        }

        // Check for API error messages in response
        if (data.error || (data.message && !data.versions && !data.file)) {
            console.error(`[ShowBox] API Error: ${data.error || data.message}`);
            return streams;
        }

        if (data.success === false) {
            console.error(`[ShowBox] API returned unsuccessful response (success=false)`);
            return streams;
        }

        if (!data.versions || !Array.isArray(data.versions) || data.versions.length === 0) {
            // Try extracting from 'file' array (alternate response format)
            if (data.file && Array.isArray(data.file) && data.file.length > 0) {
                console.log(`[ShowBox] No versions but found ${data.file.length} file(s), converting`);
                data.versions = data.file.map(f => ({
                    quality: f.quality || f.label || 'Unknown',
                    size: f.size || f.fsize || '',
                    links: f.path ? [{ link: f.path }] : (f.links || [])
                }));
            } else {
                console.log(`[ShowBox] No versions or files found in API response`);
                return streams;
            }
        }

        console.log(`[ShowBox] Processing ${data.versions.length} version(s)`);

        // Build title with year and episode info if TV
        let streamTitle = mediaInfo.title || 'Unknown Title';
        if (mediaInfo.year) {
            streamTitle += ` (${mediaInfo.year})`;
        }
        if (mediaType === 'tv' && seasonNum && episodeNum) {
            streamTitle = `${mediaInfo.title || 'Unknown'} S${String(seasonNum).padStart(2, '0')}E${String(episodeNum).padStart(2, '0')}`;
            if (mediaInfo.year) {
                streamTitle += ` (${mediaInfo.year})`;
            }
        }

        // Process each version
        data.versions.forEach(function (version, versionIndex) {
            const versionName = version.name || `Version ${versionIndex + 1}`;
            const versionSize = version.size || 'Unknown';

            // Process each link in the version
            if (version.links && Array.isArray(version.links)) {
                version.links.forEach(function (link) {
                    const rawUrl = link.url || link.link || link.path;
                    if (!rawUrl) return;

                    const linkSize = link.size || versionSize;
                    const normalizedQuality = getBestQuality(
                        link.quality,
                        link.label,
                        link.name,
                        link.fileName,
                        link.filename,
                        rawUrl,
                        version.quality,
                        version.name,
                        version.label,
                        linkSize
                    );
                    const linkName = link.name || `${normalizedQuality}`;

                    // Create stream name - use version number if multiple versions exist
                    let streamName = 'ShowBox';
                    if (data.versions.length > 1) {
                        streamName += ` V${versionIndex + 1}`;
                    }
                    streamName += ` ${normalizedQuality}`;

                    streams.push({
                        name: streamName,
                        title: streamTitle,
                        url: rawUrl,
                        quality: normalizedQuality,
                        size: formatFileSize(linkSize),
                        filename: link.fileName || link.filename || linkName || versionName,
                        headers: getShowBoxPlaybackHeaders(rawUrl),
                        provider: 'showbox',
                        speed: link.speed || null,
                        behaviorHints: {
                            bingeGroup: 'showbox',
                            notWebReady: true
                        }
                    });

                    console.log(`[ShowBox] Added ${normalizedQuality} stream from ${versionName}: ${rawUrl.substring(0, 50)}...`);
                });
            }
        });

    } catch (error) {
        console.error(`[ShowBox] Error processing response: ${error.message}`);
    }

    return streams;
}

// Main scraping function
function getStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null, scraperSettings = null) {
    console.log(`[ShowBox] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}${mediaType === 'tv' ? `, S:${seasonNum}E:${episodeNum}` : ''}`);

    // Get cookie (uiToken) - required
    const cookie = getUiToken(scraperSettings);
    if (!cookie) {
        console.log('[ShowBox] No UI token found; using public ShowBox/FEB path');
    }

    // Get OSS group - optional
    const ossGroup = getOssGroup(scraperSettings);
    if (cookie) {
        console.log(`[ShowBox] Using UI token (${cookie.length} chars)${ossGroup ? `, OSS Group: ${ossGroup}` : ' (no OSS group)'}`);
    }

    // Build API URL based on media type
    const apiUrls = SHOWBOX_API_BASES.map(function (baseUrl) {
        if (mediaType === 'tv' && seasonNum && episodeNum) {
            if (ossGroup) {
                return `${baseUrl}/media/tv/${tmdbId}/oss=${ossGroup}/${seasonNum}/${episodeNum}?cookie=${encodeURIComponent(cookie)}`;
            }
            return `${baseUrl}/media/tv/${tmdbId}/${seasonNum}/${episodeNum}?cookie=${encodeURIComponent(cookie)}`;
        }

        return `${baseUrl}/media/movie/${tmdbId}?cookie=${encodeURIComponent(cookie)}`;
    });

    console.log(`[ShowBox] Requesting ${apiUrls.length} API base(s)`);
    if (cookie) {
        console.log(`[ShowBox] Cookie length: ${cookie.length}, Expires: ${getJwtExpiryIso(cookie)}`);
    }

    const mediaInfoPromise = getTMDBDetails(tmdbId, mediaType)
        .then(function (mediaInfo) {
            console.log(`[ShowBox] TMDB Info: "${mediaInfo.title}" (${mediaInfo.year || 'N/A'})`);
            return mediaInfo;
        });

    const legacyApiRequest = function () {
        return apiUrls.reduce(function (promise, url) {
        return promise.catch(function () {
            console.log(`[ShowBox] Requesting: ${redactSensitiveUrl(url)}`);
            return makeRequest(url, { timeoutMs: SHOWBOX_LEGACY_API_TIMEOUT_MS })
                .then(function (response) {
                    console.log(`[ShowBox] API Response status: ${response.status}`);
                    return response.json();
                });
        });
        }, Promise.reject(new Error('No ShowBox API attempted')));
    };

    return mediaInfoPromise
        .then(function (mediaInfo) {
            return getShowBoxDirectStreams(mediaInfo, mediaType, seasonNum, episodeNum)
                .then(function (streams) {
                    if (streams.length > 0) {
                        return { mediaInfo, data: null, directStreams: streams };
                    }

                    return legacyApiRequest().then(function (data) {
                        return { mediaInfo, data, directStreams: [] };
                    });
                });
        })
        .then(function ({ mediaInfo, data, directStreams }) {
            if (directStreams.length > 0 && !data) {
                console.log(`[ShowBox] Returning ${directStreams.length} direct streams`);
                return directStreams;
            }

            const fallbackPromise = data
                ? Promise.resolve(data)
                : legacyApiRequest().catch(function (error) {
                    console.log(`[ShowBox] Fallback API unavailable after direct path: ${error.message}`);
                    return null;
                });

            return fallbackPromise.then(function (fallbackData) {
                // Process the response
                const streams = fallbackData ? processShowBoxResponse(fallbackData, mediaInfo, mediaType, seasonNum, episodeNum) : [];
                const seenUrls = {};
                const mergedStreams = [];

                directStreams.concat(streams).forEach(function (stream) {
                    const key = String(stream && stream.url || '').trim();
                    if (!key || seenUrls[key]) {
                        return;
                    }
                    seenUrls[key] = true;
                    mergedStreams.push(stream);
                });

                if (mergedStreams.length === 0) {
                    console.log(`[ShowBox] No streams found in API response`);
                    return [];
                }

                // Sort streams by quality (highest first)
                mergedStreams.sort(function (a, b) {
                    const qualityOrder = {
                        'Original': 6,
                        '4K': 5,
                        '1440p': 4,
                        '1080p': 3,
                        '720p': 2,
                        '480p': 1,
                        '360p': 0,
                        '240p': -1,
                        'Unknown': -2
                    };
                    return (qualityOrder[b.quality] || -2) - (qualityOrder[a.quality] || -2);
                });

                console.log(`[ShowBox] Returning ${mergedStreams.length} streams`);
                return mergedStreams;
            });
        })
        .catch(function (error) {
            console.error(`[ShowBox] Error in getStreams: ${error.message}`);
            return [];
        });
}

// Export the main function
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { getStreams };
} else {
    // For React Native environment
    global.ShowBoxScraperModule = { getStreams };
}
