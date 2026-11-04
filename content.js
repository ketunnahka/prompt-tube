(function () {
  'use strict';

  const ROOT_CLASS = 'yt-custom-rec-root';
  const FORM_ID = 'yt-custom-rec-form-root';
  const STORAGE_KEY = 'ytCustomRecLastPrompt';
  const PLAN_KEY = 'ytCustomRecPlan';
  const UI_COLLAPSED_KEY = 'ytCustomRecUiCollapsed';
  const SLOT_ATTR = 'data-yt-custom-rec-hidden-slot';

  const INSERT_EVERY = 4;
  const MAX_BOOST = 48;
  const MAX_TOPICS = 3;
  const FIRST_ROW_SLOTS = 3;
  const STATUS_PIN_MS = 6000;

  let lastPath = location.pathname + location.search;
  let fetchInFlight = false;
  let syncTimer = null;
  let blendTimer = null;
  let extensionDead = false;
  let pageObserver = null;

  const RELOAD_TAB_MSG = 'Extension was reloaded — refresh this YouTube tab (F5).';

  function isExtensionAlive() {
    if (extensionDead) return false;
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function markExtensionDead() {
    if (extensionDead) return;
    extensionDead = true;
    pageObserver?.disconnect();
    if (syncTimer) {
      window.clearTimeout(syncTimer);
      syncTimer = null;
    }
    if (blendTimer) {
      window.clearTimeout(blendTimer);
      blendTimer = null;
    }
  }

  function extensionUserMessage(err) {
    const msg = String(err?.message || err || '');
    if (!isExtensionAlive() || /extension context invalidated/i.test(msg)) {
      markExtensionDead();
      return RELOAD_TAB_MSG;
    }
    return msg || 'Something went wrong';
  }

  /** Only YouTube home recommendations feed — not watch, not other feeds. */
  function isHomeRecommendationsPage() {
    return location.pathname === '/';
  }

  function getPageKind() {
    return isHomeRecommendationsPage() ? 'home' : null;
  }

  function qs(sel, root = document) {
    return root.querySelector(sel);
  }

  function getPrimaryColumn() {
    return qs('ytd-page-manager #primary') || qs('#primary');
  }

  function getHomeGrid() {
    const primary = getPrimaryColumn();
    if (!primary) return null;
    return qs('ytd-rich-grid-renderer', primary);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatViewCount(raw) {
    if (!raw) return '';
    const s = String(raw).trim();
    if (/[KMB]/i.test(s)) {
      return s.match(/\bviews?\b/i) ? s : `${s} views`;
    }
    const numMatch = s.match(/([\d,]+)/);
    if (!numMatch) return s;
    const n = parseInt(numMatch[1].replace(/,/g, ''), 10);
    if (Number.isNaN(n)) return s;
    if (n >= 1_000_000_000) {
      const v = n / 1_000_000_000;
      return `${v >= 10 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')}B views`;
    }
    if (n >= 1_000_000) {
      const v = n / 1_000_000;
      return `${v >= 10 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')}M views`;
    }
    if (n >= 1_000) {
      const v = n / 1_000;
      return `${v >= 10 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')}K views`;
    }
    return `${n} views`;
  }

  function formatMetaLine(video) {
    const parts = [];
    if (video.channel) parts.push(video.channel);
    const views = formatViewCount(video.viewCount);
    if (views) parts.push(views);
    if (video.publishedTime) parts.push(video.publishedTime);
    return parts.join(' • ');
  }

  function mirrorNativeItemLayout(card, nativeEl) {
    try {
      if (!nativeEl?.isConnected) return;
      const cs = window.getComputedStyle(nativeEl);
      card.style.flex = cs.flex;
      card.style.flexBasis = cs.flexBasis;
      card.style.flexGrow = cs.flexGrow;
      card.style.flexShrink = cs.flexShrink;
      card.style.maxWidth = cs.maxWidth;
      card.style.minWidth = cs.minWidth;
      card.style.width = cs.width;
      card.style.padding = cs.padding;
      card.style.margin = cs.margin;
      card.style.boxSizing = cs.boxSizing;
    } catch {
      /* layout copy is best-effort */
    }
  }

  function normalizeSearchTerm(term) {
    return String(term ?? '').trim();
  }

  function topicSearchKey(term) {
    return normalizeSearchTerm(term).toLowerCase();
  }

  /** Always blend — "more kanye videos", "kanye", "minecraft" → topic to mix in. */
  function parsePrompt(prompt) {
    const raw = String(prompt).trim();
    if (!raw) return null;

    const morePatterns = [
      /^\s*more\s+(.+?)\s+videos?\s*$/i,
      /^\s*more\s+(.+?)\s+content\s*$/i,
      /^\s*more\s+(.+)\s*$/i,
    ];

    for (const re of morePatterns) {
      const m = raw.match(re);
      if (m) {
        let term = m[1].trim().replace(/^["']|["']$/g, '');
        term = term.replace(/\s+videos?\s*$/i, '').trim();
        if (term) {
          return { mode: 'blend', searchTerm: term, insertEvery: INSERT_EVERY, maxBoost: MAX_BOOST };
        }
      }
    }

    let term = raw.replace(/^["']|["']$/g, '').trim();
    term = term.replace(/\s+videos?\s*$/i, '').trim();
    if (!term) return null;

    return { mode: 'blend', searchTerm: term, insertEvery: INSERT_EVERY, maxBoost: MAX_BOOST };
  }

  function buildFormShell() {
    const root = document.createElement('div');
    root.className = ROOT_CLASS;
    root.id = FORM_ID;
    root.innerHTML = `
      <form class="yt-custom-rec-form" autocomplete="off">
        <button type="button" class="yt-custom-rec-collapse" aria-label="Hide feed controls" aria-expanded="true" title="Hide">
          <svg class="yt-custom-rec-collapse-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M7.41 15.41 12 10.83l4.59 4.58L18 14l-6-6-6 6z"></path>
          </svg>
        </button>
        <div class="yt-custom-rec-searchbox">
          <input
            class="yt-custom-rec-input"
            type="text"
            name="prompt"
            placeholder='type what to see more e.g. "kanye", "guitar tutorials", "skyrim"'
            aria-label="Feed preference"
          />
          <button type="submit" class="yt-custom-rec-submit" aria-label="Update feed">Update Feed</button>
        </div>
        <button type="button" class="yt-custom-rec-default" aria-label="Restore default YouTube feed">Default</button>
      </form>
      <div class="yt-custom-rec-tags" role="list" aria-label="Active topics"></div>
      <p class="yt-custom-rec-status" role="status" aria-live="polite"></p>
    `;
    return root;
  }

  function ensureFormChrome(root) {
    if (!root.querySelector('.yt-custom-rec-tags')) {
      const tags = document.createElement('div');
      tags.className = 'yt-custom-rec-tags';
      tags.setAttribute('role', 'list');
      tags.setAttribute('aria-label', 'Active topics');
      const status = root.querySelector('.yt-custom-rec-status');
      root.insertBefore(tags, status || null);
    }
  }

  function isStatusPinned(root) {
    if (!root || root.dataset.statusPinned !== '1') return false;
    return Date.now() < Number(root.dataset.statusPinUntil || 0);
  }

  function clearStatusPin(root) {
    if (!root) return;
    delete root.dataset.statusPinned;
    delete root.dataset.statusPinUntil;
  }

  function setStatus(root, text, isError = false) {
    ensureFormChrome(root);
    const el = root.querySelector('.yt-custom-rec-status');
    if (!el) return;
    if (isError && text) {
      root.dataset.statusPinned = '1';
      root.dataset.statusPinUntil = String(Date.now() + STATUS_PIN_MS);
    } else if (!isError) {
      clearStatusPin(root);
    }
    el.textContent = text || '';
    el.classList.toggle('yt-custom-rec-status--error', isError);
  }

  function renderTopicTags(root, topics, pageMode) {
    ensureFormChrome(root);
    const host = root.querySelector('.yt-custom-rec-tags');
    if (!host) return;

    host.innerHTML = '';
    if (!topics?.length) {
      host.hidden = true;
      return;
    }

    host.hidden = false;
    for (const topic of topics.slice(0, MAX_TOPICS)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'yt-custom-rec-tag';
      btn.setAttribute('role', 'listitem');
      btn.setAttribute('aria-label', `Remove ${topic.searchTerm}`);
      btn.innerHTML = `<span class="yt-custom-rec-tag-label">${escapeHtml(topic.searchTerm)}</span><span class="yt-custom-rec-tag-x" aria-hidden="true">×</span>`;
      btn.addEventListener('click', () => {
        removeTopic(root, topic.searchTerm, pageMode);
      });
      host.appendChild(btn);
    }
  }

  async function removeTopic(formRoot, searchTerm, pageMode) {
    const data = await storageGet(PLAN_KEY);
    const topics = normalizeTopics(data[PLAN_KEY]).filter(
      (t) => topicSearchKey(t.searchTerm) !== topicSearchKey(searchTerm)
    );

    if (!topics.length) {
      clearCustomFeed(formRoot);
      renderTopicTags(formRoot, [], pageMode);
      setStatus(formRoot, 'Default YouTube feed restored');
      return;
    }

    const blendPlan = {
      mode: 'blend',
      topics,
      insertEvery: INSERT_EVERY,
      maxBoost: MAX_BOOST,
    };
    storageSet({ [PLAN_KEY]: blendPlan });

    const applied = applyBlendToFeed(blendPlan, pageMode, { reset: true });
    if (!applied?.ok) {
      setStatus(formRoot, applied?.error || 'Could not update blend', true);
      return;
    }

    renderTopicTags(formRoot, topics, pageMode);
    clearStatusPin(formRoot);
    setStatus(formRoot, '');
  }

  function findFormRoot() {
    const primary = getPrimaryColumn();
    if (!primary) return null;
    for (const child of primary.children) {
      if (child.id === FORM_ID) return child;
    }
    return null;
  }

  function purgeMisplacedUi() {
    const primary = getPrimaryColumn();
    document.querySelectorAll(`.${ROOT_CLASS}`).forEach((node) => {
      if (!primary || node.parentElement !== primary) {
        node.remove();
      }
    });
  }

  function getFormMount() {
    const primary = getPrimaryColumn();
    const grid = getHomeGrid();
    if (!primary || !grid) return null;
    return { parent: primary, before: grid };
  }

  function teardownOffHome() {
    document.querySelectorAll(`#${FORM_ID}, .${ROOT_CLASS}`).forEach((node) => node.remove());
    restoreWatchSidebarBlend();
  }

  function restoreWatchSidebarBlend() {
    document
      .querySelectorAll(`#secondary-inner ytd-compact-video-renderer[${SLOT_ATTR}]`)
      .forEach((el) => {
        el.style.removeProperty('display');
        el.removeAttribute(SLOT_ATTR);
      });
    document
      .querySelectorAll('#secondary-inner .yt-custom-rec-compact-card, #secondary-inner .yt-custom-rec-card')
      .forEach((el) => el.remove());
  }

  function placeForm(root, mount) {
    if (mount.before) {
      if (root.parentElement !== mount.parent || root.nextElementSibling !== mount.before) {
        mount.parent.insertBefore(root, mount.before);
      }
    }
  }

  function injectForm() {
    purgeMisplacedUi();
    const mount = getFormMount();
    if (!mount) return null;

    let root = findFormRoot();

    if (!root) {
      root = buildFormShell();
      placeForm(root, mount);
    } else {
      placeForm(root, mount);
    }

    wireFormActions(root);

    return root;
  }

  function setFeedMode(mode) {
    document.body.classList.remove('yt-custom-rec-active', 'yt-custom-rec-blend', 'yt-custom-rec-replace');
    if (mode === 'blend') {
      document.body.classList.add('yt-custom-rec-active', 'yt-custom-rec-blend');
    }
  }

  function restoreNativeSlots() {
    document
      .querySelectorAll(`ytd-rich-item-renderer[${SLOT_ATTR}], ytd-compact-video-renderer[${SLOT_ATTR}]`)
      .forEach((el) => {
        el.style.removeProperty('display');
        el.removeAttribute(SLOT_ATTR);
      });
    document.querySelectorAll('.yt-custom-rec-in-grid').forEach((el) => el.remove());
  }

  function purgeLegacyReplaceState(stored) {
    if (!stored || stored.mode !== 'replace') return false;
    removeReplaceGrid();
    restoreNativeSlots();
    setFeedMode(null);
    storageRemove(PLAN_KEY);
    return true;
  }

  function removeReplaceGrid() {
    const primary = getPrimaryColumn();
    primary?.querySelectorAll('.yt-custom-rec-grid-wrap').forEach((el) => el.remove());
    document.querySelectorAll('#secondary-inner .yt-custom-rec-card').forEach((el) => el.remove());
  }

  function clearCustomFeed(formRoot) {
    restoreNativeSlots();
    removeReplaceGrid();
    setFeedMode(null);
    storageRemove([PLAN_KEY, STORAGE_KEY]);
    if (formRoot) {
      const input = formRoot.querySelector('.yt-custom-rec-input');
      if (input) input.value = '';
      clearStatusPin(formRoot);
      renderTopicTags(formRoot, [], 'rich');
    }
  }

  function getReplaceRatio(topicCount) {
    if (topicCount >= 3) return 0.9;
    if (topicCount === 2) return 0.65;
    return 0.4;
  }

  function buildEvenSlotIndices(nativeCount, targetCount) {
    if (nativeCount <= 0 || targetCount <= 0) return [];
    const count = Math.min(targetCount, nativeCount);
    if (count === 1) return [nativeCount > 1 ? 1 : 0];

    const indices = [];
    for (let k = 0; k < count; k++) {
      indices.push(Math.round((k * (nativeCount - 1)) / (count - 1)));
    }
    return [...new Set(indices)].sort((a, b) => a - b);
  }

  function videoThumbUrl(video) {
    const id = video?.videoId;
    if (!id) return '';
    const raw = String(video.thumbnailUrl || '').trim();
    if (raw.startsWith('https://i.ytimg.com/') || raw.startsWith('https://yt3.ggpht.com/')) {
      return raw;
    }
    if (raw.startsWith('//')) return `https:${raw}`;
    if (raw) return raw;
    return `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
  }

  function bindCardThumbnail(card, video) {
    const img = card.querySelector('.yt-custom-rec-thumb-img');
    if (!img) return;
    const url = videoThumbUrl(video);
    img.src = url;
    img.decoding = 'async';
    img.referrerPolicy = 'origin';
    img.addEventListener(
      'error',
      () => {
        const fallback = `https://i.ytimg.com/vi/${encodeURIComponent(video.videoId)}/mqdefault.jpg`;
        if (img.src !== fallback) img.src = fallback;
      },
      { once: true }
    );
  }

  function createRichCard(video, extraClass = '') {
    const item = document.createElement('div');
    item.className = `yt-custom-rec-card yt-custom-rec-rich-card ${extraClass}`.trim();

    const thumb = escapeHtml(videoThumbUrl(video));
    const title = escapeHtml(video.title);
    const href = `https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}`;
    const metaLine = escapeHtml(formatMetaLine(video));

    item.dataset.videoId = video.videoId;
    item.innerHTML = `
      <a class="yt-custom-rec-thumb-wrap" href="${href}" aria-label="${title}">
        <div class="yt-custom-rec-thumb">
          <img class="yt-custom-rec-thumb-img" src="${thumb}" alt="" width="480" height="270" decoding="async" referrerpolicy="origin" />
        </div>
      </a>
      <div class="yt-custom-rec-rich-meta">
        <h3 class="yt-custom-rec-rich-title">
          <a class="yt-custom-rec-link" href="${href}" title="${title}">${title}</a>
        </h3>
        ${metaLine ? `<p class="yt-custom-rec-meta-line">${metaLine}</p>` : ''}
      </div>
    `;
    bindCardThumbnail(item, video);
    return item;
  }

  function createCompactCard(video) {
    const item = document.createElement('div');
    item.className = 'yt-custom-rec-card yt-custom-rec-compact-card';
    const thumb = escapeHtml(video.thumbnailUrl);
    const title = escapeHtml(video.title);
    const channel = escapeHtml(video.channel);
    const href = `https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}`;
    const meta = escapeHtml([video.viewCount, video.publishedTime].filter(Boolean).join(' • '));

    item.innerHTML = `
      <a class="yt-custom-rec-compact-thumb" href="${href}" aria-label="${title}">
        <img class="yt-custom-rec-thumb-img" src="${thumb}" alt="" loading="lazy" />
      </a>
      <div class="yt-custom-rec-compact-details">
        <h3 class="yt-custom-rec-compact-title">
          <a class="yt-custom-rec-link" href="${href}" title="${title}">${title}</a>
        </h3>
        <p class="yt-custom-rec-compact-channel">${channel}</p>
        ${meta ? `<p class="yt-custom-rec-compact-stats">${meta}</p>` : ''}
      </div>
    `;
    return item;
  }

  function isInsideShelf(el) {
    if (el.closest('ytd-reel-shelf-renderer, ytd-rich-shelf-renderer, grid-shelf-view-model')) {
      return true;
    }
    const section = el.closest('ytd-rich-section-renderer');
    if (
      section &&
      section.querySelector(
        'ytd-reel-shelf-renderer, ytm-shorts-lockup-view-model-v2, a[href*="/shorts/"]'
      )
    ) {
      return true;
    }
    return false;
  }

  function isNativeRowVisible(el) {
    let node = el;
    while (node && node !== document.body) {
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') {
        return false;
      }
      node = node.parentElement;
    }
    return true;
  }

  function getNativeRichItemElements() {
    const grid = getHomeGrid();
    const contents = grid && qs('#contents', grid);
    if (!contents) return [];

    return [...contents.querySelectorAll('ytd-rich-item-renderer')].filter(
      (el) =>
        !isInsideShelf(el) &&
        !el.classList.contains('yt-custom-rec-card') &&
        !el.hasAttribute(SLOT_ATTR) &&
        isNativeRowVisible(el)
    );
  }

  function getNativeCompactItemElements() {
    const host =
      qs('ytd-watch-next-secondary-results-renderer #items') || qs('#secondary-inner #items');
    if (!host) return [];

    return [...host.querySelectorAll('ytd-compact-video-renderer')].filter(
      (el) => !el.classList.contains('yt-custom-rec-card') && !el.hasAttribute(SLOT_ATTR) && isNativeRowVisible(el)
    );
  }

  function waitForNativeItems(timeoutMs = 4000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const items = getNativeRichItemElements();
        if (items.length > 0) {
          resolve(items);
          return;
        }
        if (Date.now() - start >= timeoutMs) {
          resolve([]);
          return;
        }
        window.setTimeout(tick, 250);
      };
      tick();
    });
  }

  function videoIdFromRichItem(el) {
    const link =
      el.querySelector('a#video-title-link') ||
      el.querySelector('a#thumbnail') ||
      el.querySelector('a.ytd-thumbnail') ||
      el.querySelector('a[href*="/watch"]');
    const href = link?.getAttribute('href') || link?.href || '';
    const m = href.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
  }

  function sendBackgroundMessage(payload) {
    return new Promise((resolve, reject) => {
      if (!isExtensionAlive()) {
        reject(new Error(RELOAD_TAB_MSG));
        return;
      }
      try {
        chrome.runtime.sendMessage(payload, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(extensionUserMessage(chrome.runtime.lastError)));
            return;
          }
          if (!response || typeof response !== 'object') {
            resolve({ ok: false, error: 'Empty response from background script' });
            return;
          }
          resolve(response);
        });
      } catch (err) {
        reject(new Error(extensionUserMessage(err)));
      }
    });
  }

  function fetchBoost(searchTerm, maxBoost) {
    return sendBackgroundMessage({ type: 'FETCH_BOOST', searchTerm, maxBoost });
  }

  function pickBoostVideos(boostVideos, blockedIds, maxBoost) {
    const seen = new Set(blockedIds);
    const out = [];
    for (const v of boostVideos) {
      if (!v?.videoId || seen.has(v.videoId)) continue;
      seen.add(v.videoId);
      out.push(v);
      if (out.length >= maxBoost) break;
    }
    return out;
  }

  function storageGet(keys) {
    return new Promise((resolve, reject) => {
      if (!isExtensionAlive()) {
        reject(new Error(RELOAD_TAB_MSG));
        return;
      }
      try {
        chrome.storage.local.get(keys, (data) => {
          if (chrome.runtime.lastError) {
            reject(new Error(extensionUserMessage(chrome.runtime.lastError)));
            return;
          }
          resolve(data);
        });
      } catch (err) {
        reject(new Error(extensionUserMessage(err)));
      }
    });
  }

  function storageSet(items) {
    if (!isExtensionAlive()) return false;
    try {
      chrome.storage.local.set(items);
      return true;
    } catch {
      markExtensionDead();
      return false;
    }
  }

  function storageRemove(keys) {
    if (!isExtensionAlive()) return false;
    try {
      chrome.storage.local.remove(keys);
      return true;
    } catch {
      markExtensionDead();
      return false;
    }
  }

  function normalizeTopics(stored) {
    if (!stored || typeof stored !== 'object') return [];
    if (Array.isArray(stored.topics) && stored.topics.length > 0) {
      return stored.topics.filter(
        (t) => topicSearchKey(t?.searchTerm).length > 0 && Array.isArray(t.boostVideos)
      );
    }
    if (stored.searchTerm && Array.isArray(stored.boostVideos) && stored.boostVideos.length > 0) {
      return [{ searchTerm: stored.searchTerm, boostVideos: stored.boostVideos }];
    }
    return [];
  }

  function topicsLabel(topics) {
    return topics.map((t) => `more ${t.searchTerm}`).join(', ');
  }

  function clearPromptInput(formRoot) {
    const input = formRoot?.querySelector('.yt-custom-rec-input');
    if (input) input.value = '';
  }

  function prepareForBlend() {
    removeReplaceGrid();
    restoreNativeSlots();
    setFeedMode(null);
  }

  function buildBoostSlotMap(topics, nativeCount, nativeIds) {
    const slotMap = new Map();
    const usedBoostIds = new Set();
    const poolSize = Math.max(MAX_BOOST, Math.ceil(nativeCount * getReplaceRatio(topics.length)));
    const queues = topics.map((topic) => ({
      searchTerm: topic.searchTerm,
      queue: pickBoostVideos(topic.boostVideos, nativeIds, poolSize),
    }));

    function takeFromQueue(q) {
      while (q.queue.length) {
        const video = q.queue.shift();
        if (usedBoostIds.has(video.videoId)) continue;
        usedBoostIds.add(video.videoId);
        return video;
      }
      return null;
    }

    const ratio = getReplaceRatio(topics.length);
    let targetCount = Math.max(
      Math.min(topics.length, FIRST_ROW_SLOTS),
      Math.ceil(nativeCount * ratio)
    );
    targetCount = Math.min(targetCount, nativeCount);

    const slotIndices = buildEvenSlotIndices(nativeCount, targetCount);
    slotIndices.forEach((slotIndex, i) => {
      if (slotIndex >= nativeCount || slotMap.has(slotIndex)) return;
      for (let qTry = 0; qTry < queues.length; qTry++) {
        const q = queues[(i + qTry) % queues.length];
        const video = takeFromQueue(q);
        if (!video) continue;
        slotMap.set(slotIndex, { video, searchTerm: q.searchTerm });
        break;
      }
    });

    return slotMap;
  }

  function findBlendCard(index) {
    return document.querySelector(`.yt-custom-rec-in-grid[data-slot-index="${index}"]`);
  }

  function applyBlendToFeed(plan, pageMode, options = {}) {
    try {
      const topics = normalizeTopics(plan);
      if (!topics.length) {
        return { ok: false, error: 'No blend topics saved' };
      }

      const isHome = pageMode === 'rich';
      const nativeItems = isHome ? getNativeRichItemElements() : getNativeCompactItemElements();
      if (nativeItems.length === 0) {
        return {
          ok: false,
          error: 'No recommendations loaded yet — scroll once and try Update Feed again.',
        };
      }

      const nativeIds = nativeItems.map((el) => videoIdFromRichItem(el)).filter(Boolean);
      const slotMap = buildBoostSlotMap(topics, nativeItems.length, nativeIds);

      if (slotMap.size === 0) {
        return { ok: false, error: 'No new boost videos to mix in (all duplicates).' };
      }

      const shouldReset = options.reset === true;
      if (shouldReset) {
        prepareForBlend();
      } else {
        removeReplaceGrid();
      }

      let replaced = 0;
      let kept = 0;

      for (let index = 0; index < nativeItems.length; index++) {
        const nativeEl = nativeItems[index];
        const entry = slotMap.get(index);
        const existing = findBlendCard(index);

        if (!entry) {
          if (existing) existing.remove();
          if (nativeEl?.isConnected) {
            nativeEl.style.removeProperty('display');
            nativeEl.removeAttribute(SLOT_ATTR);
          }
          continue;
        }

        if (existing?.dataset.videoId === entry.video.videoId) {
          kept++;
          if (nativeEl?.isConnected && !nativeEl.hasAttribute(SLOT_ATTR)) {
            nativeEl.setAttribute(SLOT_ATTR, '1');
            nativeEl.style.setProperty('display', 'none', 'important');
          }
          continue;
        }

        if (existing) existing.remove();
        if (!nativeEl?.isConnected) continue;
        const parent = nativeEl.parentElement;
        if (!parent) continue;

        const card = isHome
          ? createRichCard(entry.video, 'yt-custom-rec-in-grid')
          : createCompactCard(entry.video);
        if (isHome) {
          card.classList.add('yt-custom-rec-in-grid');
          mirrorNativeItemLayout(card, nativeEl);
        }

        card.dataset.slotIndex = String(index);
        card.dataset.boostTopic = entry.searchTerm;

        nativeEl.setAttribute(SLOT_ATTR, '1');
        nativeEl.style.setProperty('display', 'none', 'important');
        parent.insertBefore(card, nativeEl);
        replaced++;
      }

      document.querySelectorAll('.yt-custom-rec-in-grid').forEach((card) => {
        const idx = Number(card.dataset.slotIndex);
        if (!slotMap.has(idx)) card.remove();
      });

      if (replaced === 0 && kept === 0) {
        return { ok: false, error: 'Could not place boost videos in the feed' };
      }

      setFeedMode('blend');
      return { ok: true, replaced: replaced + kept, topics };
    } catch (err) {
      return { ok: false, error: err?.message || 'Blend failed' };
    }
  }

  function applyBlendToGrid(plan) {
    return applyBlendToFeed(plan, 'rich');
  }

  async function runPrompt(prompt, formRoot, pageMode) {
    if (fetchInFlight) return;

    const plan = parsePrompt(prompt);
    const term = normalizeSearchTerm(plan?.searchTerm);
    if (!plan || !term) {
      setStatus(formRoot, 'Enter a topic to mix in (e.g. kanye).', true);
      return;
    }

    if (!isExtensionAlive()) {
      setStatus(formRoot, RELOAD_TAB_MSG, true);
      return;
    }

    fetchInFlight = true;

    const submit = formRoot.querySelector('.yt-custom-rec-submit');
    if (submit) submit.disabled = true;
    setStatus(formRoot, 'Working…');

    try {
      setStatus(formRoot, 'Loading your feed…');
      if (pageMode === 'rich') {
        const nativeItems = await waitForNativeItems();
        if (nativeItems.length === 0) {
          setStatus(formRoot, 'Wait for videos to load, then click Update Feed again.', true);
          return;
        }
      }

      const stored = await storageGet(PLAN_KEY);
      purgeLegacyReplaceState(stored[PLAN_KEY]);

      let topics = normalizeTopics(stored[PLAN_KEY]);
      const termKey = topicSearchKey(term);
      const existingIdx = topics.findIndex((t) => topicSearchKey(t.searchTerm) === termKey);

      if (existingIdx === -1 && topics.length >= MAX_TOPICS) {
        setStatus(
          formRoot,
          `You can mix up to ${MAX_TOPICS} topics at once (${topicsLabel(topics)}). Click Default to reset.`,
          true
        );
        return;
      }

      setStatus(formRoot, `Fetching ${term}…`);
      const poolSize = Math.max(MAX_BOOST, 48);
      const boostResult = await fetchBoost(term, poolSize);

      if (!boostResult.ok || !Array.isArray(boostResult.videos) || boostResult.videos.length === 0) {
        setStatus(formRoot, boostResult.error || 'Boost fetch failed', true);
        return;
      }

      const topicEntry = {
        searchTerm: term,
        boostVideos: boostResult.videos,
      };

      if (existingIdx >= 0) {
        topics[existingIdx] = topicEntry;
      } else {
        topics.push(topicEntry);
      }

      const blendPlan = {
        mode: 'blend',
        topics,
        insertEvery: INSERT_EVERY,
        maxBoost: MAX_BOOST,
      };
      storageSet({ [PLAN_KEY]: blendPlan });
      storageRemove(STORAGE_KEY);

      const applied = applyBlendToFeed(blendPlan, pageMode, { reset: true });
      if (!applied?.ok) {
        setStatus(formRoot, applied?.error || 'Blend failed', true);
        return;
      }

      clearPromptInput(formRoot);
      renderTopicTags(formRoot, applied.topics, pageMode);
      clearStatusPin(formRoot);
      setStatus(formRoot, '');
    } catch (err) {
      setStatus(formRoot, extensionUserMessage(err), true);
    } finally {
      fetchInFlight = false;
      if (submit) submit.disabled = false;
    }
  }

  function getStoredBlendPlan(stored) {
    const topics = normalizeTopics(stored);
    if (!topics.length) return null;
    return {
      mode: 'blend',
      topics,
      insertEvery: stored?.insertEvery || INSERT_EVERY,
      maxBoost: stored?.maxBoost || MAX_BOOST,
    };
  }

  function reapplyBlendFromStorage(plan) {
    if (extensionDead || !isHomeRecommendationsPage()) return false;
    const blendPlan = getStoredBlendPlan(plan);
    if (!blendPlan) return false;
    if (getNativeRichItemElements().length === 0) return false;
    const applied = applyBlendToFeed(blendPlan, 'rich', { reset: false });
    return Boolean(applied?.ok);
  }

  function scheduleBlendReapply() {
    if (
      extensionDead ||
      !isHomeRecommendationsPage() ||
      !document.body.classList.contains('yt-custom-rec-blend')
    ) {
      return;
    }
    if (blendTimer) return;
    blendTimer = window.setTimeout(async () => {
      blendTimer = null;
      if (extensionDead || !isExtensionAlive() || !isHomeRecommendationsPage()) return;

      if (getNativeRichItemElements().length === 0) return;
      if (document.querySelectorAll('.yt-custom-rec-in-grid').length > 0) return;

      try {
        const data = await storageGet(PLAN_KEY);
        if (getStoredBlendPlan(data[PLAN_KEY])) {
          reapplyBlendFromStorage(data[PLAN_KEY]);
        }
      } catch {
        /* invalidated — stop reapply loop */
      }
    }, 400);
  }

  function applyUiCollapsed(root, collapsed) {
    if (!root) return;
    root.classList.toggle('yt-custom-rec-root--collapsed', collapsed);
    const btn = root.querySelector('.yt-custom-rec-collapse');
    if (!btn) return;
    btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    btn.setAttribute('aria-label', collapsed ? 'Show feed controls' : 'Hide feed controls');
    btn.title = collapsed ? 'Show' : 'Hide';
  }

  function setUiCollapsed(root, collapsed) {
    applyUiCollapsed(root, collapsed);
    storageSet({ [UI_COLLAPSED_KEY]: collapsed });
  }

  async function syncUiCollapsed(root) {
    try {
      const data = await storageGet(UI_COLLAPSED_KEY);
      applyUiCollapsed(root, Boolean(data[UI_COLLAPSED_KEY]));
    } catch {
      applyUiCollapsed(root, false);
    }
  }

  function wireFormActions(root) {
    const form = root.querySelector('.yt-custom-rec-form');
    if (!form || form.dataset.ytCustomRecWired === '1') return;
    form.dataset.ytCustomRecWired = '1';

    root.querySelector('.yt-custom-rec-collapse')?.addEventListener('click', (e) => {
      e.preventDefault();
      const collapsed = !root.classList.contains('yt-custom-rec-root--collapsed');
      setUiCollapsed(root, collapsed);
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = root.querySelector('.yt-custom-rec-input');
      const prompt = input?.value?.trim();
      if (prompt) {
        runPrompt(prompt, root, 'rich');
      }
    });

    root.querySelector('.yt-custom-rec-default')?.addEventListener('click', (e) => {
      e.preventDefault();
      clearCustomFeed(root);
      setStatus(root, 'Default YouTube feed restored');
    });
  }

  function refreshTopicUi(root, topics, pageMode) {
    renderTopicTags(root, topics, pageMode);
    if (!isStatusPinned(root)) {
      setStatus(root, '');
    }
  }

  async function syncUI() {
    if (extensionDead) return;

    if (!isHomeRecommendationsPage()) {
      teardownOffHome();
      return;
    }

    const root = injectForm();
    if (!root) return;

    await syncUiCollapsed(root);

    if (!isExtensionAlive()) {
      setStatus(root, RELOAD_TAB_MSG, true);
      return;
    }

    try {
      const data = await storageGet(PLAN_KEY);
      const stored = data[PLAN_KEY] || {};
      if (purgeLegacyReplaceState(stored)) {
        setStatus(root, 'Default YouTube feed restored');
        return;
      }

      const blendPlan = getStoredBlendPlan(stored);
      if (!blendPlan) return;

      if (!document.querySelector('.yt-custom-rec-in-grid')) {
        reapplyBlendFromStorage(stored);
      }
      if (document.body.classList.contains('yt-custom-rec-blend')) {
        scheduleBlendReapply();
      }
      refreshTopicUi(root, blendPlan.topics, 'rich');
    } catch (err) {
      setStatus(root, extensionUserMessage(err), true);
    }
  }

  function scheduleSync() {
    if (extensionDead || syncTimer) return;
    syncTimer = window.setTimeout(() => {
      syncTimer = null;
      syncUI();
      scheduleBlendReapply();
    }, 200);
  }

  function onNavigate() {
    const path = location.pathname + location.search;
    if (path === lastPath) return;
    lastPath = path;
    scheduleSync();
  }

  document.addEventListener('yt-navigate-finish', onNavigate);

  pageObserver = new MutationObserver(scheduleSync);

  function startObserver() {
    const page = qs('ytd-page-manager') || qs('#page-manager') || document.body;
    pageObserver.observe(page, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      scheduleSync();
      startObserver();
    });
  } else {
    scheduleSync();
    startObserver();
  }
})();
