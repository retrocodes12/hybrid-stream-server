const toString = (value) => String(value ?? '').trim();

const normalizeProviderId = (value) =>
  toString(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');

const isHttpUrl = (value) => {
  try {
    const parsed = new URL(toString(value));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const parseUrlHeaders = (url) => {
  try {
    const rawHeaders = new URL(url).searchParams.get('headers');
    if (!rawHeaders) return null;
    const parsed = JSON.parse(rawHeaders);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const headers = {};
    for (const [key, value] of Object.entries(parsed)) {
      const normalizedKey = String(key || '').trim().toLowerCase();
      const normalizedValue = toString(value);
      if (!normalizedKey || !normalizedValue) continue;
      if (normalizedKey === 'referer' || normalizedKey === 'referrer') headers.Referer = normalizedValue;
      else if (normalizedKey === 'origin') headers.Origin = normalizedValue;
      else if (normalizedKey === 'user-agent') headers['User-Agent'] = normalizedValue;
    }

    return Object.keys(headers).length > 0 ? headers : null;
  } catch {
    return null;
  }
};

const getPluginForwardHeaders = (stream, url) => {
  if (stream?.headers && typeof stream.headers === 'object' && Object.keys(stream.headers).length > 0) {
    return stream.headers;
  }

  const behaviorHeaders = stream?.behaviorHints?.proxyHeaders?.request;
  if (behaviorHeaders && typeof behaviorHeaders === 'object' && Object.keys(behaviorHeaders).length > 0) {
    return behaviorHeaders;
  }

  return parseUrlHeaders(url);
};

export const normalizePluginStream = (stream, {
  adapterId,
  pluginId,
  pluginName
} = {}) => {
  if (!stream || typeof stream !== 'object') {
    return null;
  }

  const url = toString(stream.url || stream.file || stream.link);
  const magnet = toString(stream.magnet || stream.torrent);

  if (!isHttpUrl(url) && !magnet.startsWith('magnet:?')) {
    return null;
  }

  const normalizedPluginId = normalizeProviderId(pluginId || stream.provider || pluginName || adapterId);
  const sourceProvider = `${adapterId}:${normalizedPluginId}`;
  const providerLabel = pluginName || stream.provider || normalizedPluginId || adapterId;
  const headers = getPluginForwardHeaders(stream, url);

  return {
    ...stream,
    provider: adapterId,
    sourceProvider,
    pluginProvider: normalizedPluginId,
    pluginProviderName: providerLabel,
    sourceSite: providerLabel,
    ...(isHttpUrl(url) ? { url } : {}),
    ...(magnet.startsWith('magnet:?') ? { magnet } : {}),
    name: stream.name || providerLabel,
    title: stream.title || stream.description || stream.name || providerLabel,
    quality: stream.quality || stream.resolution || stream.height || 'Unknown',
    headers,
    behaviorHints: {
      ...(stream.behaviorHints || {}),
      ...(headers ? { proxyHeaders: { request: headers } } : {}),
      bingeGroup: stream.behaviorHints?.bingeGroup || sourceProvider
    }
  };
};

export const normalizePluginStreams = (streams, metadata) =>
  (Array.isArray(streams) ? streams : [])
    .map((stream) => normalizePluginStream(stream, metadata))
    .filter(Boolean);
