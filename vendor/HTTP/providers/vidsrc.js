const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const PROVIDER_ID = 'alas-vidsrc';

async function safeFetch(url, options = {}) {
  if (typeof fetchv2 === 'function') {
    const headers = options.headers || {};
    const method = options.method || 'GET';
    const body = options.body || null;
    try {
      return await fetchv2(url, headers, method, body, true, options.encoding || 'utf-8');
    } catch {
    }
  }
  return fetch(url, options);
}

function inferQualityScore(text) {
  const value = String(text || '').toLowerCase();
  if (value.includes('2160') || value.includes('4k')) return 2160;
  if (value.includes('1440')) return 1440;
  if (value.includes('1080')) return 1080;
  if (value.includes('720')) return 720;
  if (value.includes('480')) return 480;
  if (value.includes('360')) return 360;
  return 0;
}

function toQualityLabel(score) {
  if (score >= 2160) return '2160p';
  if (score >= 1440) return '1440p';
  if (score >= 1080) return '1080p';
  return 'Auto';
}

function maxResolutionFromM3u8Text(text) {
  const input = String(text || '');
  let maxY = 0;
  const re = /RESOLUTION=\s*\d+\s*x\s*(\d+)/gi;
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(input)) !== null) {
    const y = Number(m[1]);
    if (Number.isFinite(y) && y > maxY) maxY = y;
  }
  return maxY;
}

async function detectPlaylistMaxQuality(url, headers) {
  try {
    const res = await safeFetch(url, { headers: headers || {} });
    const text = res && res.ok ? await res.text() : '';
    return maxResolutionFromM3u8Text(text);
  } catch {
    return 0;
  }
}

function tmdbFetch(path) {
  return safeFetch(`${TMDB_BASE}${path}?api_key=${TMDB_API_KEY}`)
    .then(r => (r && r.ok ? r.json() : null))
    .catch(() => null);
}

async function getImdbId(tmdbId, mediaType) {
  const type = mediaType === 'tv' ? 'tv' : 'movie';
  if (type === 'movie') {
    const movie = await tmdbFetch(`/movie/${tmdbId}`);
    return movie && movie.imdb_id ? movie.imdb_id : null;
  }

  const tv = await tmdbFetch(`/tv/${tmdbId}`);
  if (!tv) return null;
  const ext = await tmdbFetch(`/tv/${tmdbId}/external_ids`);
  return ext && ext.imdb_id ? ext.imdb_id : null;
}

async function resolveCloudnestraStreams(imdbId, mediaType, seasonNum, episodeNum) {
  const headersCloud = {
    Referer: 'https://cloudnestra.com/',
    Origin: 'https://cloudnestra.com',
    'User-Agent': 'Mozilla/5.0'
  };

  const embedUrl = mediaType === 'tv'
    ? `https://vsrc.su/embed/tv?imdb=${encodeURIComponent(imdbId)}&season=${Number(seasonNum || 1)}&episode=${Number(episodeNum || 1)}`
    : `https://vsrc.su/embed/${encodeURIComponent(imdbId)}`;

  const embedRes = await safeFetch(embedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const embedHtml = embedRes && embedRes.ok ? await embedRes.text() : '';
  const iframeSrc = (embedHtml.match(/<iframe[^>]+src=["']([^"']+)["']/) || [])[1];
  if (!iframeSrc) return [];

  const iframeRes = await safeFetch(`https:${iframeSrc}`, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:145.0) Gecko/20100101 Firefox/145.0',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.5',
      referer: 'https://vsrc.su/',
      'upgrade-insecure-requests': '1'
    }
  });
  const iframeHtml = iframeRes && iframeRes.ok ? await iframeRes.text() : '';
  const prorcpSrc = (iframeHtml.match(/src:\s*["']([^"']+)["']/) || [])[1];
  if (!prorcpSrc) return [];

  const cloudRes = await safeFetch(`https://cloudnestra.com${prorcpSrc}`, { headers: { referer: 'https://cloudnestra.com/' } });
  const cloudHtml = cloudRes && cloudRes.ok ? await cloudRes.text() : '';

  const hidden = cloudHtml.match(/<div id="([^"]+)"[^>]*style=["']display\s*:\s*none;?["'][^>]*>([a-zA-Z0-9:\/.,{}\-_=+ ]+)<\/div>/);
  const divId = hidden ? hidden[1] : null;
  const divText = hidden ? hidden[2] : null;
  if (!divId || !divText) return [];

  const decRes = await safeFetch('https://enc-dec.app/api/dec-cloudnestra', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: divText, div_id: divId })
  });
  const decJson = decRes && decRes.ok ? await decRes.json() : null;
  const urls = decJson && Array.isArray(decJson.result) ? decJson.result : [];
  if (urls.length === 0) return [];

  const results = [];
  for (let idx = 0; idx < urls.length; idx++) {
    const streamUrl = urls[idx];
    if (!streamUrl) continue;

    const scoreFromUrl = inferQualityScore(streamUrl);
    const maxFromPlaylist = await detectPlaylistMaxQuality(streamUrl, headersCloud);
    const assumed = streamUrl.includes('.m3u8') ? 1080 : 0;
    const score = Math.max(scoreFromUrl, maxFromPlaylist, assumed);
    if (score < 1080) continue;

    results.push({
      name: `${PROVIDER_ID} - Server ${idx + 1}`,
      url: streamUrl,
      quality: toQualityLabel(score),
      headers: headersCloud,
      provider: PROVIDER_ID,
      _score: score
    });
  }

  return results
    .sort((a, b) => b._score - a._score)
    .map(({ _score, ...rest }) => rest);
}

async function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  try {
    const type = mediaType === 'tv' ? 'tv' : 'movie';
    const imdbId = await getImdbId(tmdbId, type);
    if (!imdbId) return [];
    return await resolveCloudnestraStreams(imdbId, type, seasonNum, episodeNum);
  } catch {
    return [];
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
}
