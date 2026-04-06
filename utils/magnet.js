const VIDEO_EXTENSIONS = new Set([
  '.mkv',
  '.mp4',
  '.avi',
  '.mov',
  '.wmv',
  '.flv',
  '.webm',
  '.m4v',
  '.mpg',
  '.mpeg',
  '.ts'
]);

export const extractInfoHash = (magnetUri) => {
  const normalized = String(magnetUri || '').trim();
  const match = normalized.match(/xt=urn:btih:([a-zA-Z0-9]+)/);

  if (!match?.[1]) {
    return null;
  }

  return match[1].toLowerCase();
};

export const isVideoFile = (fileName) => {
  const normalized = String(fileName || '').toLowerCase();

  for (const extension of VIDEO_EXTENSIONS) {
    if (normalized.endsWith(extension)) {
      return true;
    }
  }

  return false;
};

export const resolveRequestedFile = (files, { fileIndex, fileName } = {}) => {
  if (!Array.isArray(files) || files.length === 0) {
    return null;
  }

  if (Number.isInteger(fileIndex) && fileIndex >= 0 && fileIndex < files.length) {
    return files[fileIndex];
  }

  if (typeof fileName === 'string' && fileName.trim()) {
    const normalizedNeedle = fileName.trim().toLowerCase();

    const exactMatch = files.find((file) => file.name.toLowerCase() === normalizedNeedle);

    if (exactMatch) {
      return exactMatch;
    }

    const partialMatch = files.find((file) => file.name.toLowerCase().includes(normalizedNeedle));

    if (partialMatch) {
      return partialMatch;
    }
  }

  const preferredVideo = files
    .filter((file) => isVideoFile(file.name))
    .sort((left, right) => right.length - left.length)[0];

  if (preferredVideo) {
    return preferredVideo;
  }

  return files.slice().sort((left, right) => right.length - left.length)[0];
};
