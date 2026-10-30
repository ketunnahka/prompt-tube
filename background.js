/**
 * Fetches YouTube HTML and extracts video metadata from ytInitialData.
 */

const YT_SEARCH_URL = 'https://www.youtube.com/results?search_query=';
/** YouTube search filter: type = Shorts */
const YT_SEARCH_SHORTS_SP = 'EgIQAQ%3D%3D';
const DEFAULT_MAX_BOOST = 48;
const DEFAULT_MAX_REPLACE = 24;

function extractYtInitialData(html) {
  const markers = [
    /var\s+ytInitialData\s*=\s*/,
    /window\s*\[\s*["']ytInitialData["']\s*\]\s*=\s*/,
    /window\.ytInitialData\s*=\s*/,
    /ytInitialData\s*=\s*/,
  ];

  let startIndex = -1;
  for (const re of markers) {
    const m = re.exec(html);
    if (m) {
      startIndex = m.index + m[0].length;
      break;
    }
  }

  if (startIndex === -1) {
    return null;
  }

  const jsonStart = html.indexOf('{', startIndex);
  if (jsonStart === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escape = false;
  let endIndex = -1;

  for (let i = jsonStart; i < html.length; i++) {
    const ch = html[i];

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        endIndex = i + 1;
        break;
      }
    }
  }

  if (endIndex === -1) {
    return null;
  }

  try {
    return JSON.parse(html.slice(jsonStart, endIndex));
  } catch {
    return null;
  }
}

function getTextRuns(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  if (obj.simpleText) return obj.simpleText;
  if (Array.isArray(obj.runs)) {
    return obj.runs.map((r) => r.text || '').join('');
  }
  return '';
}

function pickThumbnail(thumbnail) {
  const thumbs = thumbnail?.thumbnails;
  if (!Array.isArray(thumbs) || thumbs.length === 0) return '';
  return thumbs[thumbs.length - 1].url || thumbs[0].url || '';
}

function parseDurationSeconds(text) {
  if (!text || typeof text !== 'string') return 0;
  const parts = text.trim().split(':').map((p) => parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return 0;
}

function rendererWatchUrl(renderer) {
  const nep = renderer?.navigationEndpoint;
  return nep?.commandMetadata?.webCommandMetadata?.url || '';
}

function isShortVideoRenderer(renderer) {
  if (!renderer?.videoId) return false;

  const url = rendererWatchUrl(renderer);
  if (typeof url === 'string' && url.includes('/shorts/')) return true;

  if (renderer.navigationEndpoint?.reelWatchEndpoint?.videoId) return true;

  const lenSec = parseDurationSeconds(getTextRuns(renderer.lengthText));
  if (lenSec > 0 && lenSec <= 60) return true;

  return false;
}

function videoFromRenderer(renderer, extra = {}) {
  if (!renderer || renderer.videoId == null) return null;

  const title = getTextRuns(renderer.title);
  const channel =
    getTextRuns(renderer.ownerText) ||
    getTextRuns(renderer.longBylineText) ||
    getTextRuns(renderer.shortBylineText) ||
    '';

  const isShort = Boolean(extra.isShort) || isShortVideoRenderer(renderer);

  return {
    videoId: renderer.videoId,
    title: title || 'Untitled',
    channel,
    thumbnailUrl: pickThumbnail(renderer.thumbnail),
    viewCount:
      getTextRuns(renderer.viewCountText) || getTextRuns(renderer.shortViewCountText) || '',
    publishedTime: getTextRuns(renderer.publishedTimeText),
    isShort,
  };
}

function videoFromReelRenderer(reel) {
  if (!reel) return null;
  const videoId = reel.videoId || reel.navigationEndpoint?.reelWatchEndpoint?.videoId;
  if (!videoId) return null;

  const title =
    getTextRuns(reel.headline) ||
    getTextRuns(reel.accessibility?.accessibilityData?.label) ||
    getTextRuns(reel.title) ||
    'Short';

  return {
    videoId,
    title,
    channel: getTextRuns(reel.shortBylineText) || getTextRuns(reel.byline) || '',
    thumbnailUrl: pickThumbnail(reel.thumbnail),
    viewCount: getTextRuns(reel.viewCountText) || getTextRuns(reel.shortViewCountText) || '',
    publishedTime: getTextRuns(reel.publishedTimeText) || '',
    isShort: true,
  };
}

function collectVideoRenderers(node, out) {
  if (!node || typeof node !== 'object') return;

  if (node.videoRenderer) {
    out.push(node.videoRenderer);
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectVideoRenderers(item, out);
    }
    return;
  }

  for (const key of Object.keys(node)) {
    if (key === 'videoRenderer') continue;
    collectVideoRenderers(node[key], out);
  }
}

function collectReelItemRenderers(node, out) {
  if (!node || typeof node !== 'object') return;

  if (node.reelItemRenderer) {
    out.push(node.reelItemRenderer);
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectReelItemRenderers(item, out);
    }
    return;
  }

  for (const key of Object.keys(node)) {
    if (key === 'reelItemRenderer') continue;
    collectReelItemRenderers(node[key], out);
  }
}

function parseSearchResults(initialData, limit) {
  const renderers = [];
  collectVideoRenderers(initialData, renderers);

  const seen = new Set();
  const videos = [];

  for (const r of renderers) {
    const v = videoFromRenderer(r);
    if (!v || seen.has(v.videoId)) continue;
    seen.add(v.videoId);
    videos.push(v);
    if (videos.length >= limit) break;
  }

  return videos;
}

function pickThumbnailFromNode(node) {
  if (!node || typeof node !== 'object') return '';
  return (
    pickThumbnail(node.thumbnail) ||
    pickThumbnail(node.contentImage?.thumbnailRenderer?.thumbnail) ||
    pickThumbnail(node.thumbnailViewModel?.image) ||
    pickThumbnail(node.onTap?.inlinePlayerData?.thumbnail) ||
    ''
  );
}

function videoFromReelWatchNode(node) {
  const videoId = node.navigationEndpoint?.reelWatchEndpoint?.videoId;
  if (!videoId) return null;

  const title =
    getTextRuns(node.title) ||
    getTextRuns(node.headline) ||
    getTextRuns(node.overlayMetadata?.primaryMetadata?.metadataParts?.[0]?.text) ||
    getTextRuns(node.accessibility?.accessibilityData?.label) ||
    'Short';

  const thumbnailUrl = pickThumbnailFromNode(node);
  if (!thumbnailUrl) return null;

  return {
    videoId,
    title,
    channel: getTextRuns(node.shortBylineText) || getTextRuns(node.byline) || '',
    thumbnailUrl,
    viewCount: getTextRuns(node.viewCountText) || getTextRuns(node.shortViewCountText) || '',
    publishedTime: getTextRuns(node.publishedTimeText) || '',
    isShort: true,
  };
}

function collectDeepReelWatchVideos(node, out, seenIds, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 55) return;

  const v = videoFromReelWatchNode(node);
  if (v && !seenIds.has(v.videoId)) {
    seenIds.add(v.videoId);
    out.push(v);
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectDeepReelWatchVideos(item, out, seenIds, depth + 1);
    }
    return;
  }

  for (const key of Object.keys(node)) {
    collectDeepReelWatchVideos(node[key], out, seenIds, depth + 1);
  }
}

function parseShortsSearchResults(initialData, limit) {
  const reels = [];
  collectReelItemRenderers(initialData, reels);

  const renderers = [];
  collectVideoRenderers(initialData, renderers);

  const deepReel = [];
  const deepSeen = new Set();
  collectDeepReelWatchVideos(initialData, deepReel, deepSeen);

  const seen = new Set();
  const videos = [];

  function pushVideo(v) {
    if (!v?.videoId || !v.isShort || seen.has(v.videoId)) return false;
    seen.add(v.videoId);
    videos.push(v);
    return videos.length >= limit;
  }

  for (const reel of reels) {
    const v = videoFromReelRenderer(reel);
    if (pushVideo(v)) return videos;
  }

  for (const v of deepReel) {
    if (pushVideo(v)) return videos;
  }

  for (const r of renderers) {
    if (!isShortVideoRenderer(r)) continue;
    const v = videoFromRenderer(r, { isShort: true });
    if (pushVideo(v)) return videos;
  }

  return videos;
}

async function fetchSearchVideosOnce(searchTerm, limit, options = {}) {
  const query = encodeURIComponent(String(searchTerm).trim());
  if (!query) {
    return { ok: false, error: 'Empty search term' };
  }

  let url = `${YT_SEARCH_URL}${query}`;
  if (options.shortsOnly && options.useShortsSp !== false) {
    url += `&sp=${options.shortsSp || YT_SEARCH_SHORTS_SP}`;
  }

  try {
    const response = await fetch(url, {
      credentials: 'omit',
      headers: { 'Accept-Language': 'en-US,en;q=0.9' },
    });

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }

    const html = await response.text();
    const initialData = extractYtInitialData(html);

    if (!initialData) {
      return { ok: false, error: 'Could not parse ytInitialData from search page' };
    }

    const videos = options.shortsOnly
      ? parseShortsSearchResults(initialData, limit)
      : parseSearchResults(initialData, limit);

    if (videos.length === 0) {
      return {
        ok: false,
        error: options.shortsOnly ? 'No Shorts found for this search' : 'No videos found for this search',
      };
    }

    return { ok: true, videos };
  } catch (err) {
    return { ok: false, error: err.message || 'Fetch failed' };
  }
}

async function fetchSearchVideos(searchTerm, limit, options = {}) {
  if (!options.shortsOnly) {
    return fetchSearchVideosOnce(searchTerm, limit, options);
  }

  const attempts = [
    { term: searchTerm, useShortsSp: true, shortsSp: YT_SEARCH_SHORTS_SP },
    { term: searchTerm, useShortsSp: true, shortsSp: 'EgIYAQ%3D%3D' },
    { term: `${searchTerm} #shorts`, useShortsSp: false },
    { term: `${searchTerm} shorts`, useShortsSp: false },
  ];

  let last = { ok: false, error: 'No Shorts found for this search' };
  for (const attempt of attempts) {
    last = await fetchSearchVideosOnce(attempt.term, limit, {
      shortsOnly: true,
      useShortsSp: attempt.useShortsSp,
      shortsSp: attempt.shortsSp,
    });
    if (last.ok && last.videos.length > 0) {
      return last;
    }
  }
  return last;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'FETCH_BOOST') {
    const limit = message.maxBoost || DEFAULT_MAX_BOOST;
    fetchSearchVideos(message.searchTerm, limit, { shortsOnly: Boolean(message.shortsOnly) })
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message || 'Unknown error' }));
    return true;
  }

  if (message?.type === 'FETCH_RECOMMENDATIONS') {
    const limit = message.maxVideos || DEFAULT_MAX_REPLACE;
    fetchSearchVideos(message.prompt, limit)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message || 'Unknown error' }));
    return true;
  }

  return false;
});
