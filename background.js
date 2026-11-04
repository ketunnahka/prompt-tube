/**
 * Fetches YouTube HTML and extracts video metadata from ytInitialData.
 */

const YT_SEARCH_URL = 'https://www.youtube.com/results?search_query=';
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

  const byWidth = [...thumbs].sort((a, b) => (a.width || 0) - (b.width || 0));
  const nearHq = byWidth.find((t) => (t.width || 0) >= 320 && (t.width || 0) <= 480);
  if (nearHq?.url) return nearHq.url;

  const mid = byWidth[Math.floor(byWidth.length / 2)];
  return mid?.url || byWidth[byWidth.length - 1]?.url || thumbs[0]?.url || '';
}

function videoFromRenderer(renderer) {
  if (!renderer || renderer.videoId == null) return null;

  const title = getTextRuns(renderer.title);
  const channel =
    getTextRuns(renderer.ownerText) ||
    getTextRuns(renderer.longBylineText) ||
    getTextRuns(renderer.shortBylineText) ||
    '';

  let thumbnailUrl = pickThumbnail(renderer.thumbnail);
  if (!thumbnailUrl) {
    thumbnailUrl = `https://i.ytimg.com/vi/${renderer.videoId}/hqdefault.jpg`;
  }

  return {
    videoId: renderer.videoId,
    title: title || 'Untitled',
    channel,
    thumbnailUrl,
    viewCount:
      getTextRuns(renderer.viewCountText) || getTextRuns(renderer.shortViewCountText) || '',
    publishedTime: getTextRuns(renderer.publishedTimeText),
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

async function fetchSearchVideos(searchTerm, limit) {
  const query = encodeURIComponent(String(searchTerm).trim());
  if (!query) {
    return { ok: false, error: 'Empty search term' };
  }

  const url = `${YT_SEARCH_URL}${query}`;

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

    const videos = parseSearchResults(initialData, limit);

    if (videos.length === 0) {
      return { ok: false, error: 'No videos found for this search' };
    }

    return { ok: true, videos };
  } catch (err) {
    return { ok: false, error: err.message || 'Fetch failed' };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'FETCH_BOOST') {
    const limit = message.maxBoost || DEFAULT_MAX_BOOST;
    fetchSearchVideos(message.searchTerm, limit)
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
