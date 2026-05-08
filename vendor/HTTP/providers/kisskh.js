const MAIN_URL = 'https://kisskh.ovh';
const KISSKH_API = 'https://script.google.com/macros/s/AKfycbzn8B31PuDxzaMa9_CQ0VGEDasFqfzI5bXvjaIZH4DM8DNq9q6xj1ALvZNz_JT3jF0suA/exec?id=';
const TMDB_API_KEY = 'b030404650f279792a8d3287232358e3';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Referer: `${MAIN_URL}/`
};

async function safeJson(url, options) {
  const response = await fetch(url, {
    ...(options || {}),
    headers: {
      ...HEADERS,
      ...(options && options.headers ? options.headers : {})
    }
  });
  const text = await response.text();
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  if (!text || text.trim().startsWith('<') || (!contentType.includes('json') && !/^[\[{]/.test(text.trim()))) {
    throw new Error(`Expected JSON, got ${contentType || 'unknown content type'}`);
  }

  return JSON.parse(text);
}

function findBestMatch(searchList, title) {
  const normalizedTitle = String(title || '').trim().toLowerCase();
  const list = Array.isArray(searchList) ? searchList : [];

  return list.find((item) => String(item.title || '').trim().toLowerCase() === normalizedTitle)
    || list.find((item) => String(item.title || '').trim().toLowerCase().includes(normalizedTitle))
    || list[0]
    || null;
}

function pickEpisode(episodes, mediaType, episodeNum) {
  const list = Array.isArray(episodes) ? episodes : [];

  if (mediaType === 'movie') {
    return list[list.length - 1] || null;
  }

  return list.find((episode) => Number.parseInt(String(episode.number), 10) === Number.parseInt(String(episodeNum), 10))
    || null;
}

function toStreams(sources) {
  return [sources?.Video, sources?.ThirdParty]
    .filter(Boolean)
    .filter((url) => String(url).includes('.m3u8') || String(url).includes('.mp4'))
    .map((url) => ({
      name: String(url).includes('.m3u8') ? 'KissKH HLS' : 'KissKH MP4',
      title: 'KissKH Stream',
      url,
      quality: 'Auto',
      headers: { Origin: MAIN_URL, Referer: MAIN_URL },
      provider: 'kisskh'
    }));
}

async function getStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
  try {
    const normalizedMediaType = mediaType === 'tv' || mediaType === 'series' ? 'tv' : 'movie';
    const tmdbData = await safeJson(`https://api.themoviedb.org/3/${normalizedMediaType}/${tmdbId}?api_key=${TMDB_API_KEY}`);
    const title = tmdbData.title || tmdbData.name || tmdbData.original_title || tmdbData.original_name;

    if (!title) {
      return [];
    }

    const searchList = await safeJson(`${MAIN_URL}/api/DramaList/Search?q=${encodeURIComponent(title)}&type=0`);
    const matched = findBestMatch(searchList, title);

    if (!matched?.id) {
      return [];
    }

    const detail = await safeJson(`${MAIN_URL}/api/DramaList/Drama/${matched.id}?isq=false`);
    const targetEpisode = pickEpisode(detail?.episodes, normalizedMediaType, episodeNum);

    if (!targetEpisode?.id) {
      return [];
    }

    const keyData = await safeJson(`${KISSKH_API}${targetEpisode.id}&version=2.8.10`);

    if (!keyData?.key) {
      return [];
    }

    const sources = await safeJson(`${MAIN_URL}/api/DramaList/Episode/${targetEpisode.id}.png?err=false&ts=&time=&kkey=${keyData.key}`);
    return toStreams(sources);
  } catch (error) {
    console.warn(`KissKH skipped: ${error.message || error}`);
    return [];
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
}
