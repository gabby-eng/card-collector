// ── Config ──────────────────────────────────────────────────
const API      = 'https://api.pokemontcg.io/v2';
const API_KEY  = '78372518-aa47-40c9-9590-9fd68c6a4a26';
const PAGE_SIZE = 20;

// ── JSONBin config ────────────────────────────────────────────
// Get a free API key at https://jsonbin.io → API Keys
// Paste your key below — keep this file out of your public repo!
const JSONBIN_KEY        = '$2a$10$Arph0QzjFA1B4UAuBw6W2OisDl2Uv973QZaHnIAHWCdUnaNrDPsuG';
const JSONBIN_API        = 'https://api.jsonbin.io/v3';
const JSONBIN_COLLECTION = ''; // optional: your JSONBin collection ID to organise bins

// ── API cache ─────────────────────────────────────────────────
// Caches responses in localStorage with a TTL.
// Card search caches also store the set's updatedAt timestamp so they
// can be invalidated when a set is updated, rather than just on TTL expiry.
const CACHE_TTL_CARDS     = 1000 * 60 * 60 * 24;      // 24h fallback TTL for card searches
const CACHE_TTL_SETS      = 1000 * 60 * 60 * 24 * 7;  // 7 days for sets list
const CACHE_MAX_KEYS      = 100;
const SET_TIMESTAMPS_KEY  = 'ptcg_set_timestamps'; // { setId: updatedAt }
const LAST_CHECK_KEY      = 'ptcg_last_staleness_check';
const CHECK_INTERVAL      = 1000 * 60 * 60; // only re-check API staleness once per hour

function cacheGet(key) {
  try {
    const raw = localStorage.getItem('ptcg_cache:' + key);
    if (!raw) return null;
    const { ts, ttl, data } = JSON.parse(raw);
    if (Date.now() - ts > ttl) { localStorage.removeItem('ptcg_cache:' + key); return null; }
    return data;
  } catch { return null; }
}

function cacheSet(key, data, ttl, meta = {}) {
  try {
    const allKeys = Object.keys(localStorage).filter(k => k.startsWith('ptcg_cache:'));
    if (allKeys.length >= CACHE_MAX_KEYS) {
      const entries = allKeys.map(k => {
        try { return { k, ts: JSON.parse(localStorage.getItem(k)).ts }; } catch { return { k, ts: 0 }; }
      }).sort((a, b) => a.ts - b.ts);
      entries.slice(0, Math.ceil(CACHE_MAX_KEYS * 0.2)).forEach(e => localStorage.removeItem(e.k));
    }
    localStorage.setItem('ptcg_cache:' + key, JSON.stringify({ ts: Date.now(), ttl, data, ...meta }));
  } catch {}
}

async function cachedFetch(url, headers, ttl, meta = {}) {
  const cached = cacheGet(url);
  if (cached) return cached;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  cacheSet(url, data, ttl, meta);
  return data;
}

// ── Smarter cache invalidation ────────────────────────────────
// On startup, fetch only the most recently updated set and compare
// its updatedAt against our stored timestamps. If anything changed,
// purge stale card-search caches for that set and refresh the sets list.

function getStoredTimestamps() {
  try { return JSON.parse(localStorage.getItem(SET_TIMESTAMPS_KEY) || '{}'); }
  catch { return {}; }
}

function saveTimestamps(ts) {
  try { localStorage.setItem(SET_TIMESTAMPS_KEY, JSON.stringify(ts)); } catch {}
}

function invalidateCacheForSet(setId) {
  // Remove any cached card search that mentions this set ID in its URL
  Object.keys(localStorage)
    .filter(k => k.startsWith('ptcg_cache:') && k.includes(setId))
    .forEach(k => localStorage.removeItem(k));
  // Also bust the sets list cache so updated card counts appear
  Object.keys(localStorage)
    .filter(k => k.startsWith('ptcg_cache:') && k.includes('/sets?'))
    .forEach(k => localStorage.removeItem(k));
}

async function checkForSetUpdates() {
  // Rate-limit: only check once per hour
  const lastCheck = parseInt(localStorage.getItem(LAST_CHECK_KEY) || '0', 10);
  if (Date.now() - lastCheck < CHECK_INTERVAL) return;
  localStorage.setItem(LAST_CHECK_KEY, Date.now());

  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['X-Api-Key'] = API_KEY;

  try {
    // Fetch only the single most recently updated set — tiny payload
    const res = await fetch(
      `${API}/sets?orderBy=-updatedAt&pageSize=10`,
      { headers }
    );
    if (!res.ok) return;
    const data = await res.json();
    const sets = data.data || [];
    const stored = getStoredTimestamps();
    let changed = false;

    sets.forEach(set => {
      if (stored[set.id] && stored[set.id] !== set.updatedAt) {
        // This set was updated since we last cached it — invalidate its cache
        invalidateCacheForSet(set.id);
        console.info(`[PCBox] Set "${set.name}" updated — cache invalidated`);
        changed = true;
      }
      // Always update our stored timestamp
      stored[set.id] = set.updatedAt;
    });

    if (changed) saveTimestamps(stored);
    else saveTimestamps(stored); // still save new sets we hadn't seen before
  } catch {
    // Silently ignore — cache staleness check is best-effort
  }
}

// Run staleness check in the background on startup (non-blocking)
checkForSetUpdates();

// ── Collections state ────────────────────────────────────────
// Structure: { collections: [{id, name, cards: {cardId: card}}], activeId }
let store      = loadStore();
let activeColId = store.activeId;

// ── Owned state ──────────────────────────────────────────────
// Separate from collections — a card can be owned without being in any list
let owned = loadOwned(); // Set of card IDs

function activeCol() { return store.collections.find(c => c.id === activeColId); }
function activeCards() { return activeCol()?.cards || {}; }

// ── Search state ─────────────────────────────────────────────
let currentTab   = 'search';
let currentQuery = '';
let currentType  = '';
let currentPage  = 1;
let totalCards   = 0;
let searchMode   = 'name';
let lastResults  = [];

const TYPES = ['Colorless','Darkness','Dragon','Fairy','Fighting','Fire',
               'Grass','Lightning','Metal','Psychic','Water'];

// ── Theme ─────────────────────────────────────────────────────
function applyTheme(t) {
  document.documentElement.classList.toggle('light', t === 'light');
  document.getElementById('theme-toggle').textContent = t === 'light' ? '🌙' : '☀️';
}
function toggleTheme() {
  const next = document.documentElement.classList.contains('light') ? 'dark' : 'light';
  localStorage.setItem('ptcg_theme', next);
  applyTheme(next);
}
const savedTheme = localStorage.getItem('ptcg_theme') ||
  (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
applyTheme(savedTheme);

// ── Init ──────────────────────────────────────────────────────
renderTypeFilters();
updateCount();
showSearchState('idle');

function renderTypeFilters() {
  const row = document.getElementById('type-filters');
  TYPES.forEach(t => {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = t;
    chip.onclick = () => toggleType(t, chip);
    row.appendChild(chip);
  });
}

function toggleType(t, chip) {
  if (currentType === t) {
    currentType = ''; chip.classList.remove('active');
  } else {
    document.querySelectorAll('#type-filters .chip').forEach(c => c.classList.remove('active'));
    currentType = t; chip.classList.add('active');
  }
  if (currentQuery) { currentPage = 1; doSearch(); }
}

// ── Tab switching ─────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  document.getElementById('tab-search').style.display     = tab === 'search'     ? '' : 'none';
  document.getElementById('tab-collection').style.display = tab === 'collection' ? '' : 'none';
  document.querySelectorAll('.tab-bar button').forEach((b, i) => {
    b.classList.toggle('active', (i === 0 && tab === 'search') || (i === 1 && tab === 'collection'));
  });
  if (tab === 'collection') renderCollectionTab();
}

// ── Search ────────────────────────────────────────────────────
let allSets = [];       // cached from API
let currentSetId = '';  // selected set ID

function setSearchMode(mode) {
  searchMode = mode;
  document.getElementById('mode-name').classList.toggle('active', mode === 'name');
  document.getElementById('mode-artist').classList.toggle('active', mode === 'artist');
  document.getElementById('mode-set').classList.toggle('active', mode === 'set');

  const isSet    = mode === 'set';
  const isArtist = mode === 'artist';

  document.getElementById('search-input').placeholder =
    isSet ? 'Search by Pokémon name within set…' :
    isArtist ? 'Search by artist name…' : 'Search by Pokémon name…';

  // Show/hide search row — hidden in set mode until a set is chosen
  document.getElementById('type-filters').style.display  = (isArtist || isSet) ? 'none' : '';
  document.getElementById('set-picker-wrap').style.display = isSet ? '' : 'none';
  document.getElementById('search-row-wrap').style.display = isSet ? 'none' : '';

  currentQuery = ''; currentSetId = ''; lastResults = [];
  showSearchState('idle');
  document.getElementById('pagination').classList.add('hidden');

  if (isSet && allSets.length === 0) loadSets();
  else if (isSet) renderSetList();
}

async function loadSets() {
  document.getElementById('set-list').innerHTML =
    '<div class="spinner" style="margin:20px auto;width:24px;height:24px;border-width:2px"></div>';
  const url = `${API}/sets?orderBy=-releaseDate&pageSize=250`;
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['X-Api-Key'] = API_KEY;
  try {
    const data = await cachedFetch(url, headers, CACHE_TTL_SETS);
    allSets = data.data || [];
    renderSetList();
  } catch (e) {
    document.getElementById('set-list').innerHTML =
      `<div style="color:var(--muted);font-size:0.85rem;padding:12px">Failed to load sets: ${e.message}</div>`;
  }
}

function filterSetList() {
  renderSetList(document.getElementById('set-filter-input').value.trim().toLowerCase());
}

function renderSetList(filter = '') {
  const list = document.getElementById('set-list');
  list.innerHTML = '';

  const filtered = filter
    ? allSets.filter(s => s.name.toLowerCase().includes(filter) || s.series.toLowerCase().includes(filter))
    : allSets;

  if (!filtered.length) {
    list.innerHTML = '<div style="color:var(--muted);font-size:0.85rem;padding:12px">No sets match that filter.</div>';
    return;
  }

  // Group by series
  const groups = {};
  filtered.forEach(s => {
    if (!groups[s.series]) groups[s.series] = [];
    groups[s.series].push(s);
  });

  Object.entries(groups).forEach(([series, sets]) => {
    const label = document.createElement('div');
    label.className = 'set-series-label';
    label.textContent = series;
    list.appendChild(label);

    sets.forEach(set => {
      const item = document.createElement('div');
      item.className = 'set-item' + (set.id === currentSetId ? ' active' : '');
      item.innerHTML = `
        <img src="${set.images?.symbol || ''}" alt="${set.name}" onerror="this.style.display='none'" />
        <div class="set-item-info">
          <div class="set-item-name">${set.name}</div>
          <div class="set-item-meta">${set.releaseDate || ''}</div>
        </div>
        <span class="set-item-count">${set.total ?? set.printedTotal ?? ''} cards</span>`;
      item.onclick = () => selectSet(set);
      list.appendChild(item);
    });
  });
}

function selectSet(set) {
  currentSetId = set.id;
  currentQuery = '';
  currentPage  = 1;

  // Show the name-within-set search bar
  document.getElementById('search-row-wrap').style.display = '';
  document.getElementById('search-input').placeholder = `Search within ${set.name}…`;
  document.getElementById('search-input').value = '';

  // Highlight selected set in list
  document.querySelectorAll('.set-item').forEach(el => el.classList.remove('active'));
  event?.currentTarget?.classList.add('active');

  // Fetch all cards in this set immediately
  fetchSetCards();
}

async function fetchSetCards() {
  const btn = document.getElementById('search-btn');
  btn.disabled = true;
  showSearchState('loading');

  const nameQ = document.getElementById('search-input').value.trim();
  let query = `set.id:${currentSetId}`;
  if (nameQ) query += ` name:${nameQ}*`;

  const params = new URLSearchParams({ q: query, page: currentPage, pageSize: PAGE_SIZE, orderBy: 'number' });
  const url = `${API}/cards?${params}`;
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['X-Api-Key'] = API_KEY;

  try {
    const data = await cachedFetch(url, headers, CACHE_TTL_CARDS);
    totalCards  = data.totalCount || 0;
    lastResults = data.data || [];
    renderResults(lastResults);
    renderPagination();
  } catch (e) {
    showSearchState('error', e.message);
  } finally {
    btn.disabled = false;
  }
}

async function doSearch() {
  const input = document.getElementById('search-input');
  const q = input.value.trim();
  if (!q) return;
  input.blur();
  currentQuery = q; currentPage = 1;
  await fetchCards();
}

async function randomCard() {
  const btn = document.getElementById('random-btn');
  const searchBtn = document.getElementById('search-btn');
  btn.disabled = true;
  searchBtn.disabled = true;
  btn.classList.add('spinning');
  showSearchState('loading');
  document.getElementById('pagination').classList.add('hidden');

  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['X-Api-Key'] = API_KEY;

  try {
    // First: get total card count (cached for 24h)
    const countData = await cachedFetch(`${API}/cards?pageSize=1&page=1`, headers, CACHE_TTL_CARDS);
    const total = countData.totalCount || 10000;

    // Pick a random page — never cache random results
    const randomPage = Math.floor(Math.random() * total) + 1;
    const cardRes = await fetch(
      `${API}/cards?pageSize=1&page=${randomPage}`,
      { headers }
    );
    if (!cardRes.ok) throw new Error(`HTTP ${cardRes.status}`);
    const cardData = await cardRes.json();
    const card = cardData.data?.[0];
    if (!card) throw new Error('No card returned');

    // Show it — clear search input so it's obvious this is random
    document.getElementById('search-input').value = '';
    currentQuery = '';
    lastResults = [card];
    renderResults([card]);
  } catch (e) {
    showSearchState('error', e.message);
  } finally {
    btn.disabled = false;
    searchBtn.disabled = false;
    // Remove spinning class after animation completes
    setTimeout(() => btn.classList.remove('spinning'), 500);
  }
}

async function changePage(dir) {
  currentPage += dir;
  if (searchMode === 'set') await fetchSetCards();
  else await fetchCards();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function fetchCards() {
  const btn = document.getElementById('search-btn');
  btn.disabled = true;
  showSearchState('loading');

  let query = searchMode === 'artist'
    ? `artist:"${currentQuery}"`
    : `name:${currentQuery}*`;
  if (searchMode === 'name' && currentType) query += ` types:${currentType}`;

  const params = new URLSearchParams({ q: query, page: currentPage, pageSize: PAGE_SIZE, orderBy: 'name' });
  const url = `${API}/cards?${params}`;
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['X-Api-Key'] = API_KEY;

  try {
    const data = await cachedFetch(url, headers, CACHE_TTL_CARDS);
    totalCards  = data.totalCount || 0;
    lastResults = data.data || [];
    renderResults(lastResults);
    renderPagination();
  } catch (e) {
    showSearchState('error', e.message);
  } finally {
    btn.disabled = false;
  }
}

function showSearchState(state, msg) {
  const el = document.getElementById('search-results');
  document.getElementById('pagination').classList.toggle('hidden', state !== 'results');
  if (state !== 'results') {
    document.getElementById('results-toolbar').style.display = 'none';
  }
  if (state === 'idle') {
    el.innerHTML = `<div class="state-msg"><div class="big">🃏</div>
      <h3>Search for any Pokémon card</h3>
      <p>Search by name (e.g. "Charizard") or switch to search by artist</p></div>`;
  } else if (state === 'loading') {
    el.innerHTML = '<div class="spinner"></div>';
  } else if (state === 'error') {
    el.innerHTML = `<div class="state-msg"><div class="big">⚠️</div>
      <h3>Something went wrong</h3><p>${msg || 'Check your connection and try again.'}</p></div>`;
  } else if (state === 'empty') {
    el.innerHTML = `<div class="state-msg"><div class="big">🔍</div>
      <h3>No cards found</h3>
      <p>${searchMode === 'artist' ? 'Try a different artist name.' : 'Try a different name or remove the type filter.'}</p></div>`;
  }
}

function renderResults(cards) {
  if (!cards.length) { showSearchState('empty'); return; }
  const el = document.getElementById('search-results');
  el.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'card-grid';
  cards.forEach(card => grid.appendChild(buildCard(card)));
  el.appendChild(grid);
  document.getElementById('pagination').classList.remove('hidden');

  // Show toolbar
  const toolbar = document.getElementById('results-toolbar');
  toolbar.style.display = 'flex';
  const countEl = document.getElementById('results-count');
  const label = totalCards > PAGE_SIZE
    ? `<strong>${totalCards.toLocaleString()}</strong> cards found`
    : `<strong>${cards.length}</strong> card${cards.length !== 1 ? 's' : ''} found`;
  countEl.innerHTML = label;

  // Reset add-all button
  const addBtn = document.getElementById('add-all-btn');
  addBtn.disabled = false;
  addBtn.classList.remove('done');
  document.getElementById('add-all-label').textContent = 'Add all to collection';
}

// ── Collection picker (Add all) ───────────────────────────────
let _pendingAddAll = false; // tracks whether a fetch is in progress

function addAllToCollection() {
  // Build the picker list
  const list = document.getElementById('col-picker-list');
  list.innerHTML = '';

  store.collections.forEach(col => {
    const row = document.createElement('div');
    row.className = 'col-picker-row';
    row.innerHTML = `
      <div>
        <div class="col-picker-row-name">${col.name}</div>
        <div class="col-picker-row-count">${Object.keys(col.cards).length} card${Object.keys(col.cards).length !== 1 ? 's' : ''}</div>
      </div>
      <span class="col-picker-row-arrow">→</span>`;
    row.onclick = () => { closeColPicker(); doAddAll(col); };
    list.appendChild(row);
  });

  // "Create new collection" option
  const newBtn = document.createElement('button');
  newBtn.className = 'col-picker-new';
  newBtn.innerHTML = '<span style="font-size:1.1rem">＋</span> Create new collection';
  newBtn.onclick = () => {
    closeColPicker();
    const name = prompt('Name your new collection:')?.trim();
    if (!name) return;
    const id = 'col_' + Date.now();
    const col = { id, name, cards: {} };
    store.collections.push(col);
    activeColId = id;
    store.activeId = id;
    saveStore(); updateCount();
    doAddAll(col);
  };
  list.appendChild(newBtn);

  // Update subtitle
  const cardWord = (totalCards > PAGE_SIZE ? totalCards : lastResults.length);
  document.getElementById('col-picker-count').textContent =
    `${cardWord.toLocaleString()} card${cardWord !== 1 ? 's' : ''} will be added`;

  document.getElementById('col-picker-overlay').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeColPicker() {
  document.getElementById('col-picker-overlay').classList.add('hidden');
  document.body.style.overflow = '';
}

function closeColPickerIfBg(e) {
  if (e.target === document.getElementById('col-picker-overlay')) closeColPicker();
}

async function doAddAll(targetCol) {
  const btn = document.getElementById('add-all-btn');
  const labelEl = document.getElementById('add-all-label');
  btn.disabled = true;

  // Single page — use cached results
  if (totalCards <= PAGE_SIZE || !currentQuery) {
    lastResults.forEach(card => { targetCol.cards[card.id] = card; });
    saveStore(); updateCount();
    btn.classList.add('done');
    labelEl.textContent = `✓ Added ${lastResults.length} to "${targetCol.name}"`;
    if (currentTab === 'collection') renderCollectionTab();
    return;
  }

  // Multi-page — fetch everything
  const totalPages = Math.ceil(totalCards / PAGE_SIZE);
  let added = 0;
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['X-Api-Key'] = API_KEY;

  let query = searchMode === 'artist'
    ? `artist:"${currentQuery}"`
    : searchMode === 'set'
    ? `set.id:${currentSetId}${currentQuery ? ` name:${currentQuery}*` : ''}`
    : `name:${currentQuery}*`;
  if (searchMode === 'name' && currentType) query += ` types:${currentType}`;

  try {
    for (let page = 1; page <= totalPages; page++) {
      labelEl.textContent = `Fetching page ${page}/${totalPages}…`;
      const params = new URLSearchParams({ q: query, page, pageSize: PAGE_SIZE, orderBy: 'name' });
      const res = await fetch(`${API}/cards?${params}`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      (data.data || []).forEach(card => { targetCol.cards[card.id] = card; added++; });
    }
    saveStore(); updateCount();
    btn.classList.add('done');
    labelEl.textContent = `✓ Added ${added} to "${targetCol.name}"`;
    if (currentTab === 'collection') renderCollectionTab();
  } catch (e) {
    labelEl.textContent = 'Add all to collection';
    btn.disabled = false;
    alert(`Failed to fetch all cards: ${e.message}`);
  }
}

function renderPagination() {
  const totalPages = Math.ceil(totalCards / PAGE_SIZE);
  document.getElementById('page-info').textContent = `Page ${currentPage} of ${totalPages}`;
  document.getElementById('prev-btn').disabled = currentPage <= 1;
  document.getElementById('next-btn').disabled = currentPage >= totalPages;
}

// ── Collections tab ───────────────────────────────────────────
let hideOwned = false;

function toggleHideOwned() {
  hideOwned = !hideOwned;
  const btn = document.getElementById('hide-owned-btn');
  btn.classList.toggle('active', hideOwned);
  btn.innerHTML = hideOwned
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
         <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
         <circle cx="12" cy="12" r="3"/>
       </svg> Show owned`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
         <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
         <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
         <line x1="1" y1="1" x2="23" y2="23"/>
       </svg> Hide owned`;
  renderCollectionGrid();
}

function renderCollectionTab() {
  hideOwned = false;
  const btn = document.getElementById('hide-owned-btn');
  if (btn) {
    btn.classList.remove('active');
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
    </svg> Hide owned`;
  }
  renderCollectionsBar();
  renderCompletionBar();
  renderCollectionGrid();
}

function renderCompletionBar() {
  const wrap = document.getElementById('col-completion');
  const col  = activeCol();
  if (!col) { wrap.style.display = 'none'; return; }

  const total = Object.keys(col.cards).length;
  if (total === 0) { wrap.style.display = 'none'; return; }

  const ownedCount = Object.keys(col.cards).filter(id => owned.has(id)).length;
  const pct        = Math.round((ownedCount / total) * 100);
  const complete   = ownedCount === total;

  wrap.style.display = '';
  document.getElementById('col-completion-label').textContent =
    `${ownedCount} / ${total} owned`;
  document.getElementById('col-completion-pct').textContent =
    complete ? '✦ Complete!' : `${pct}%`;

  const fill = document.getElementById('col-completion-fill');
  requestAnimationFrame(() => {
    fill.style.width = `${pct}%`;
    fill.classList.toggle('complete', complete);
  });
}

function renderCollectionsBar() {
  const bar = document.getElementById('collections-bar');
  bar.innerHTML = '';

  store.collections.forEach((col, idx) => {
    const tab = document.createElement('div');
    tab.className = 'col-tab' + (col.id === activeColId ? ' active' : '');
    tab.draggable = true;
    tab.dataset.colId = col.id;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'col-tab-name';
    nameSpan.textContent = col.name;

    const countSpan = document.createElement('span');
    countSpan.className = 'col-tab-count';
    countSpan.textContent = Object.keys(col.cards).length;

    tab.appendChild(nameSpan);
    tab.appendChild(countSpan);
    tab.onclick = () => { activeColId = col.id; store.activeId = col.id; saveStore(); renderCollectionTab(); };

    // ⋯ menu button
    const menuBtn = document.createElement('button');
    menuBtn.className = 'col-menu-btn';
    menuBtn.textContent = '⋯';
    menuBtn.onclick = e => { e.stopPropagation(); showColMenu(e, col); };
    tab.appendChild(menuBtn);

    // ── Drag and Drop (desktop) ──────────────────────────────
    tab.addEventListener('dragstart', e => {
      dragSrcId = col.id;
      // Delay adding class so the drag ghost renders before the tab fades
      setTimeout(() => tab.classList.add('dragging'), 0);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', col.id);
    });
    tab.addEventListener('dragend', () => {
      tab.classList.remove('dragging');
      clearDropIndicators();
      dragSrcId = null;
    });
    tab.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dragSrcId && dragSrcId !== col.id) showDropIndicator(tab, e);
    });
    tab.addEventListener('dragleave', e => {
      // Only clear if the mouse actually left this tab (not just moved to a child)
      if (!tab.contains(e.relatedTarget)) clearDropIndicators();
    });
    tab.addEventListener('drop', e => {
      e.preventDefault();
      if (dragSrcId && dragSrcId !== col.id) reorderCollection(dragSrcId, col.id, e);
      clearDropIndicators();
    });

    // ── Touch drag (mobile) ──────────────────────────────────
    tab.addEventListener('touchstart', onTouchStart, { passive: true });
    tab.addEventListener('touchmove',  onTouchMove,  { passive: false });
    tab.addEventListener('touchend',   onTouchEnd,   { passive: true });

    bar.appendChild(tab);
  });

  // New collection button
  const newBtn = document.createElement('button');
  newBtn.className = 'new-col-btn';
  newBtn.innerHTML = '＋ New list';
  newBtn.onclick = () => createCollection();
  bar.appendChild(newBtn);

  // Allow dropping anywhere on the bar (handles gaps between tabs)
  bar.addEventListener('dragover', e => e.preventDefault());
  bar.addEventListener('drop',     e => { e.preventDefault(); clearDropIndicators(); });
}

// ── Drag state ───────────────────────────────────────────────
let dragSrcId   = null;
let touchSrcId  = null;
let touchClone  = null;
let touchStartX = 0;
let touchStartY = 0;

function showDropIndicator(targetTab, e) {
  clearDropIndicators();
  const rect = targetTab.getBoundingClientRect();
  const midX = rect.left + rect.width / 2;
  const clientX = e.clientX ?? e.touches?.[0]?.clientX ?? midX;
  targetTab.classList.add(clientX < midX ? 'drop-before' : 'drop-after');
}

function clearDropIndicators() {
  document.querySelectorAll('.col-tab').forEach(t => {
    t.classList.remove('drop-before', 'drop-after');
  });
}

function reorderCollection(srcId, targetId, e) {
  const srcIdx    = store.collections.findIndex(c => c.id === srcId);
  const targetIdx = store.collections.findIndex(c => c.id === targetId);
  if (srcIdx === -1 || targetIdx === -1) return;

  const [moved] = store.collections.splice(srcIdx, 1);

  // Determine whether to insert before or after the target
  let insertIdx = targetIdx;
  if (e) {
    const targetTab = document.querySelector(`.col-tab[data-col-id="${targetId}"]`);
    if (targetTab) {
      const rect  = targetTab.getBoundingClientRect();
      const midX  = rect.left + rect.width / 2;
      const clientX = e.clientX ?? e.changedTouches?.[0]?.clientX ?? midX;
      // After splice, recalculate target index
      const newTargetIdx = store.collections.findIndex(c => c.id === targetId);
      insertIdx = clientX >= midX ? newTargetIdx + 1 : newTargetIdx;
    }
  }

  store.collections.splice(insertIdx, 0, moved);
  saveStore();
  renderCollectionsBar();
}

// ── Touch drag handlers (long-press to drag) ─────────────────
let longPressTimer = null;
const LONG_PRESS_MS = 450;

function onTouchStart(e) {
  const tab = e.currentTarget;
  touchSrcId   = tab.dataset.colId;
  touchStartX  = e.touches[0].clientX;
  touchStartY  = e.touches[0].clientY;

  // Start long-press timer — drag only activates after holding
  longPressTimer = setTimeout(() => {
    longPressTimer = null;
    // Trigger haptic feedback on iOS if available
    if (navigator.vibrate) navigator.vibrate(30);
    // Mark as drag-ready; onTouchMove will create the clone on next move
    tab.classList.add('long-press-ready');
  }, LONG_PRESS_MS);
}

function onTouchMove(e) {
  if (!touchSrcId) return;

  const dx = Math.abs(e.touches[0].clientX - touchStartX);
  const dy = Math.abs(e.touches[0].clientY - touchStartY);

  // If the finger moved more than 8px before long-press fired, cancel it
  // so normal horizontal scroll of the bar works unimpeded
  if (longPressTimer && (dx > 8 || dy > 8)) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
    touchSrcId = null;
    return;
  }

  // Long-press hasn't fired yet — let the browser scroll normally
  if (longPressTimer) return;

  const srcTab = document.querySelector(`.col-tab[data-col-id="${touchSrcId}"]`);
  if (!srcTab) return;

  // Prevent page scroll once dragging
  e.preventDefault();

  if (!touchClone) {
    touchClone = srcTab.cloneNode(true);
    touchClone.className = 'col-tab touch-drag-clone';
    const rect = srcTab.getBoundingClientRect();
    touchClone.style.cssText = `
      position:fixed; z-index:9999; pointer-events:none;
      width:${rect.width}px; opacity:0.9;
      left:${rect.left}px; top:${rect.top}px;
      transform:scale(1.08); transition:transform 0.15s;
    `;
    document.body.appendChild(touchClone);
    srcTab.classList.add('dragging');
    srcTab.classList.remove('long-press-ready');
  }

  const tx = e.touches[0].clientX - touchStartX;
  const srcTabCurrent = document.querySelector(`.col-tab[data-col-id="${touchSrcId}"]`);
  if (srcTabCurrent) {
    const rect = srcTabCurrent.getBoundingClientRect();
    touchClone.style.left = (rect.left + tx) + 'px';
  }

  // Find which tab we're hovering over
  const cloneRect = touchClone.getBoundingClientRect();
  const cloneMid  = cloneRect.left + cloneRect.width / 2;
  clearDropIndicators();
  document.querySelectorAll(`.col-tab:not(.dragging)`).forEach(t => {
    const r = t.getBoundingClientRect();
    if (cloneMid >= r.left && cloneMid <= r.right) {
      t.classList.add(cloneMid < r.left + r.width / 2 ? 'drop-before' : 'drop-after');
    }
  });
}

function onTouchEnd(e) {
  // Always clear long-press timer on finger lift
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }

  // Clean up long-press-ready state even if no drag happened
  document.querySelectorAll('.long-press-ready').forEach(t => t.classList.remove('long-press-ready'));

  if (!touchSrcId) return;

  if (touchClone) {
    const beforeEl = document.querySelector('.col-tab.drop-before');
    const afterEl  = document.querySelector('.col-tab.drop-after');
    const targetEl = beforeEl || afterEl;
    const targetId = targetEl?.dataset.colId;

    touchClone.remove(); touchClone = null;
    document.querySelector(`.col-tab[data-col-id="${touchSrcId}"]`)?.classList.remove('dragging');
    clearDropIndicators();

    if (targetId && targetId !== touchSrcId) {
      reorderCollection(touchSrcId, targetId, afterEl ? { clientX: 999999 } : { clientX: 0 });
    }
  }

  touchSrcId = null;
}



function renderCollectionGrid() {
  const el = document.getElementById('collection-grid');
  const col = activeCol();
  if (!col) { el.innerHTML = ''; return; }
  const allCards = Object.values(col.cards);
  if (!allCards.length) {
    el.innerHTML = `<div class="state-msg"><div class="big">📦</div>
      <h3>"${col.name}" is empty</h3>
      <p>Search for cards and tap <em>+ Add</em> to add them here.</p></div>`;
    return;
  }
  const cards = hideOwned ? allCards.filter(c => !owned.has(c.id)) : allCards;
  if (!cards.length) {
    el.innerHTML = `<div class="state-msg"><div class="big">✦</div>
      <h3>You own everything here!</h3>
      <p>All cards in this collection are marked as owned.</p></div>`;
    return;
  }
  el.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'card-grid';
  cards.forEach(card => grid.appendChild(buildCard(card)));
  el.appendChild(grid);
}

// ── Collection management ─────────────────────────────────────

// ── JSONBin share via code ────────────────────────────────────
// Uses a single "index bin" on JSONBin to map short codes → bin IDs,
// so any device with the same API key can resolve any code.
const CODE_CHARS  = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LEN    = 6;
const INDEX_BIN_KEY = 'ptcg_index_bin_id';
// Paste your index bin ID here after your first share — get it from
// localStorage.getItem('ptcg_index_bin_id') in your browser console.
// This lets any device find the shared index without prior setup.
const INDEX_BIN_ID  = ''; // e.g. '6634f2a9ad19ca34f8a1b2c3'

function makeCode() {
  let code = '';
  for (let i = 0; i < CODE_LEN; i++)
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return code;
}

function jsonbinHeaders(extra = {}) {
  return { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_KEY, ...extra };
}

// ── Index bin helpers ─────────────────────────────────────────
// The index bin holds { code: binId, ... } for all shared collections.

async function getIndexBin() {
  // Use hardcoded ID first, then fall back to localStorage
  const indexBinId = INDEX_BIN_ID || localStorage.getItem(INDEX_BIN_KEY);
  if (!indexBinId) return { id: null, index: {} };
  const res = await fetch(`${JSONBIN_API}/b/${indexBinId}/latest`, {
    headers: jsonbinHeaders({ 'X-Bin-Meta': 'false' }),
  });
  if (!res.ok) return { id: indexBinId, index: {} };
  const index = await res.json();
  // Also persist to localStorage so saveIndexBin can update it
  if (indexBinId) localStorage.setItem(INDEX_BIN_KEY, indexBinId);
  return { id: indexBinId, index: typeof index === 'object' ? index : {} };
}

async function saveIndexBin(indexBinId, index) {
  if (!indexBinId) {
    // Create the index bin for the first time
    const res = await fetch(`${JSONBIN_API}/b`, {
      method: 'POST',
      headers: jsonbinHeaders({ 'X-Bin-Name': 'poketcg-share-index', 'X-Bin-Private': 'true' }),
      body: JSON.stringify(index),
    });
    if (!res.ok) throw new Error(`JSONBin error ${res.status}`);
    const data = await res.json();
    const newId = data.metadata?.id;
    if (!newId) throw new Error('No bin ID returned for index');
    localStorage.setItem(INDEX_BIN_KEY, newId);
    return newId;
  } else {
    // Update existing index bin
    const res = await fetch(`${JSONBIN_API}/b/${indexBinId}`, {
      method: 'PUT',
      headers: jsonbinHeaders(),
      body: JSON.stringify(index),
    });
    if (!res.ok) throw new Error(`JSONBin error ${res.status}`);
    return indexBinId;
  }
}

// ── Share ─────────────────────────────────────────────────────
async function shareViaCode() {
  if (!JSONBIN_KEY || JSONBIN_KEY === 'YOUR_JSONBIN_API_KEY_HERE') {
    alert('Add your JSONBin API key to script.js to use share codes.\n\nGet a free key at jsonbin.io');
    return;
  }

  const col = activeCol();
  if (!col) return;

  openShareCodeModal('<div class="spinner" style="margin:30px auto"></div>');

  const cardIds    = Object.keys(col.cards);
  const ownedInCol = cardIds.filter(id => owned.has(id));
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    collection: { name: col.name, cards: col.cards },
    owned: ownedInCol,
  };

  try {
    // 1. Upload the collection bin
    const colHeaders = jsonbinHeaders({
      'X-Bin-Name': col.name.slice(0, 128),
      'X-Bin-Private': 'true',
    });
    if (JSONBIN_COLLECTION) colHeaders['X-Collection-Id'] = JSONBIN_COLLECTION;

    const colRes = await fetch(`${JSONBIN_API}/b`, {
      method: 'POST',
      headers: colHeaders,
      body: JSON.stringify(payload),
    });
    if (!colRes.ok) throw new Error(`JSONBin error ${colRes.status}`);
    const colData = await colRes.json();
    const binId   = colData.metadata?.id;
    if (!binId) throw new Error('No bin ID returned');

    // 2. Generate a unique code and add it to the index bin
    const { id: indexBinId, index } = await getIndexBin();
    let code;
    // Make sure the code isn't already taken
    do { code = makeCode(); } while (index[code]);
    index[code] = binId;
    await saveIndexBin(indexBinId, index);

    openShareCodeModal(`
      <div style="text-align:center;padding-bottom:8px">
        <div style="font-family:'Exo 2',sans-serif;font-weight:800;font-size:1.1rem;margin-bottom:4px">
          Share this code
        </div>
        <div style="font-size:0.82rem;color:var(--muted);margin-bottom:16px">
          Send it to anyone — they can enter it in the app to import<br>"${col.name}"
        </div>
        <div class="share-code-display" onclick="copyShareCode('${code}')">${code}</div>
        <div class="share-code-hint">Tap the code to copy it</div>
      </div>`);
  } catch (e) {
    openShareCodeModal(`<div class="state-msg"><div class="big">⚠️</div>
      <h3>Couldn't generate code</h3><p>${e.message}</p></div>`);
  }
}

function copyShareCode(code) {
  navigator.clipboard?.writeText(code).catch(() => {});
  const el = document.querySelector('.share-code-display');
  if (!el) return;
  const orig = el.textContent;
  el.textContent = 'Copied!';
  setTimeout(() => { el.textContent = orig; }, 1500);
}

// ── Receive ───────────────────────────────────────────────────
async function receiveViaCode() {
  if (!JSONBIN_KEY || JSONBIN_KEY === 'YOUR_JSONBIN_API_KEY_HERE') {
    alert('Add your JSONBin API key to script.js to use share codes.\n\nGet a free key at jsonbin.io');
    return;
  }

  openShareCodeModal(`
    <div style="text-align:center;padding-bottom:8px">
      <div style="font-family:'Exo 2',sans-serif;font-weight:800;font-size:1.1rem;margin-bottom:4px">
        Enter share code
      </div>
      <div style="font-size:0.82rem;color:var(--muted);margin-bottom:16px">
        Type the 6-character code from your friend
      </div>
      <input class="share-code-input" id="share-code-entry" maxlength="6"
             placeholder="A1B2C3" oninput="this.value=this.value.toUpperCase()"
             onkeydown="if(event.key==='Enter')submitShareCode()" />
      <button class="share-code-submit" id="share-code-submit-btn" onclick="submitShareCode()">
        Import collection
      </button>
    </div>`);

  setTimeout(() => document.getElementById('share-code-entry')?.focus(), 100);
}

async function submitShareCode() {
  const input = document.getElementById('share-code-entry');
  const btn   = document.getElementById('share-code-submit-btn');
  const code  = input?.value.trim().toUpperCase();
  if (!code || code.length !== CODE_LEN) {
    input?.style.setProperty('border-color', 'var(--accent2)');
    setTimeout(() => input?.style.removeProperty('border-color'), 800);
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Fetching…';

  try {
    // 1. Look up code in the index bin
    const { index } = await getIndexBin();
    const binId = index[code];
    if (!binId) throw new Error(`Code "${code}" not found. Check the code and try again.`);

    // 2. Fetch the collection bin
    const res = await fetch(`${JSONBIN_API}/b/${binId}/latest`, {
      headers: jsonbinHeaders({ 'X-Bin-Meta': 'false' }),
    });
    if (!res.ok) throw new Error(`JSONBin error ${res.status}`);
    const payload = await res.json();
    closeShareCode();
    applyImportedPayload(payload);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Import collection';
    const errEl = document.createElement('div');
    errEl.style.cssText = 'color:var(--accent2);font-size:0.8rem;margin-top:10px;text-align:center';
    errEl.textContent = e.message;
    // Remove any previous error
    btn.parentElement.querySelector('.share-err')?.remove();
    errEl.className = 'share-err';
    btn.after(errEl);
  }
}

function openShareCodeModal(innerHtml) {
  document.getElementById('share-code-inner').innerHTML = innerHtml;
  document.getElementById('share-code-overlay').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeShareCode() {
  document.getElementById('share-code-overlay').classList.add('hidden');
  document.body.style.overflow = '';
}

function closeShareCodeIfBg(e) {
  if (e.target === document.getElementById('share-code-overlay')) closeShareCode();
}

function applyImportedPayload(payload) {
  if (!payload.collection?.name || !payload.collection?.cards) {
    alert('Invalid collection data in this bin.');
    return;
  }
  const importedCol   = payload.collection;
  const importedOwned = Array.isArray(payload.owned) ? payload.owned : [];
  const existing = store.collections.find(c => c.name === importedCol.name);
  let targetCol;

  if (existing) {
    const choice = confirm(
      `A collection named "${importedCol.name}" already exists.\n\nOK — Merge cards into it\nCancel — Create a new copy`
    );
    if (choice) {
      Object.assign(existing.cards, importedCol.cards);
      targetCol = existing;
    } else {
      const newId = 'col_' + Date.now();
      targetCol = { id: newId, name: `${importedCol.name} (imported)`, cards: importedCol.cards };
      store.collections.push(targetCol);
      activeColId = newId; store.activeId = newId;
    }
  } else {
    const newId = 'col_' + Date.now();
    targetCol = { id: newId, name: importedCol.name, cards: importedCol.cards };
    store.collections.push(targetCol);
    activeColId = newId; store.activeId = newId;
  }

  importedOwned.forEach(id => owned.add(id));
  saveStore(); saveOwned(); updateCount(); renderCollectionTab();

  const cardCount  = Object.keys(importedCol.cards).length;
  const ownedCount = importedOwned.length;
  alert(`Imported "${targetCol.name}" — ${cardCount} card${cardCount !== 1 ? 's' : ''}, ${ownedCount} marked as owned.`);
}

function createCollection() {
  const name = prompt('Name your new collection:')?.trim();
  if (!name) return;
  const id = 'col_' + Date.now();
  store.collections.push({ id, name, cards: {} });
  activeColId = id;
  store.activeId = id;
  saveStore();
  updateCount();
  renderCollectionTab();
}

function renameCollection(col) {
  const name = prompt('Rename collection:', col.name)?.trim();
  if (!name) return;
  col.name = name;
  saveStore();
  renderCollectionTab();
}

function deleteCollection(col) {
  if (store.collections.length === 1) {
    alert('You need at least one collection.');
    return;
  }
  if (!confirm(`Delete "${col.name}" and all its cards?`)) return;
  store.collections = store.collections.filter(c => c.id !== col.id);
  if (activeColId === col.id) {
    activeColId = store.collections[0].id;
    store.activeId = activeColId;
  }
  saveStore();
  updateCount();
  renderCollectionTab();
}

function showColMenu(e, col) {
  const menu = document.getElementById('ctx-menu');
  menu.innerHTML = '';

  const renameBtn = document.createElement('button');
  renameBtn.innerHTML = '✏️ Rename';
  renameBtn.onclick = () => { hideCtxMenu(); renameCollection(col); };

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'danger';
  deleteBtn.innerHTML = '🗑 Delete';
  deleteBtn.onclick = () => { hideCtxMenu(); deleteCollection(col); };

  menu.appendChild(renameBtn);
  menu.appendChild(deleteBtn);

  // Position near the button
  const rect = e.target.getBoundingClientRect();
  menu.style.display = 'block';
  const menuW = 150, menuH = 80;
  let top  = rect.bottom + 6;
  let left = rect.left - menuW + rect.width;
  if (left < 8) left = 8;
  if (top + menuH > window.innerHeight - 8) top = rect.top - menuH - 6;
  menu.style.top  = top  + 'px';
  menu.style.left = left + 'px';

  setTimeout(() => document.addEventListener('click', hideCtxMenu, { once: true }), 0);
}

function hideCtxMenu() {
  document.getElementById('ctx-menu').style.display = 'none';
}

// ── Card DOM ──────────────────────────────────────────────────
function getMarketPrice(card) {
  const prices = card.tcgplayer?.prices;
  if (!prices) return null;
  // Prefer normal, then holofoil, then first available finish
  const finish = prices.normal ?? prices.holofoil ?? prices.reverseHolofoil
    ?? Object.values(prices)[0] ?? null;
  const market = finish?.market;
  return typeof market === 'number' ? market : null;
}

function formatPrice(price) {
  return '$' + price.toFixed(2);
}

function buildCard(card) {
  const inCol   = !!activeCards()[card.id];
  const isOwned = owned.has(card.id);
  const wrap = document.createElement('div');
  wrap.className = 'pcard' + (inCol ? ' in-collection' : '') + (isOwned ? ' owned' : '');
  wrap.onclick = () => openModal(card);

  // Owned star badge (top-left)
  if (isOwned) {
    const ob = document.createElement('div');
    ob.className = 'owned-badge'; ob.textContent = '✦';
    wrap.appendChild(ob);
  }

  // In-collection check badge (top-right)
  if (inCol) {
    const badge = document.createElement('div');
    badge.className = 'in-collection-badge'; badge.textContent = '✓';
    wrap.appendChild(badge);
  }

  // Image wrapped for shimmer overlay
  const imgWrap = document.createElement('div');
  imgWrap.className = 'pcard-img-wrap';
  const img = document.createElement('img');
  img.className = 'pcard-img loading';
  img.alt = card.name; img.loading = 'lazy';
  img.onload  = () => img.classList.remove('loading');
  img.onerror = () => { img.classList.remove('loading'); img.style.opacity = '0.3'; };
  img.src = card.images?.small || '';
  imgWrap.appendChild(img);
  wrap.appendChild(imgWrap);

  const body = document.createElement('div');
  body.className = 'pcard-body';
  body.innerHTML = `<div class="pcard-name">${card.name}</div>
    <div class="pcard-set">${card.set?.name || '—'}${card.number ? ` · <span class="pcard-number">${card.number}/${card.set?.printedTotal ?? card.set?.total ?? '?'}</span>` : ''}</div>`;
  wrap.appendChild(body);

  const footer = document.createElement('div');
  footer.className = 'pcard-footer';
  const price = getMarketPrice(card);
  footer.innerHTML = `<span class="rarity-badge">${card.rarity || '—'}</span>${price !== null ? `<span class="price-badge">${formatPrice(price)}</span>` : ''}`;

  // Owned button
  const ownedBtn = document.createElement('button');
  ownedBtn.className = 'owned-btn' + (isOwned ? ' is-owned' : '');
  ownedBtn.title = isOwned ? 'Mark as not owned' : 'Mark as owned';
  ownedBtn.textContent = isOwned ? '✦' : '✦';
  ownedBtn.onclick = e => { e.stopPropagation(); toggleOwned(card.id, wrap, ownedBtn); };
  footer.appendChild(ownedBtn);

  // Collect button
  const btn = document.createElement('button');
  btn.className = 'collect-btn' + (inCol ? ' collected' : '');
  btn.textContent = inCol ? '✓ Added' : '+ Add';
  btn.onclick = e => { e.stopPropagation(); toggleCollect(card, btn, wrap); };
  footer.appendChild(btn);

  wrap.appendChild(footer);
  return wrap;
}

function toggleOwned(cardId, wrap, btn) {
  if (owned.has(cardId)) {
    owned.delete(cardId);
    wrap.classList.remove('owned');
    btn.classList.remove('is-owned');
    btn.title = 'Mark as owned';
    wrap.querySelector('.owned-badge')?.remove();
  } else {
    owned.add(cardId);
    wrap.classList.add('owned');
    btn.classList.add('is-owned');
    btn.title = 'Mark as not owned';
    if (!wrap.querySelector('.owned-badge')) {
      const ob = document.createElement('div');
      ob.className = 'owned-badge'; ob.textContent = '✦';
      wrap.prepend(ob);
    }
  }
  saveOwned();
  // Check if any collection is now fully owned
  if (owned.has(cardId)) checkCollectionComplete(cardId);
  // Refresh modal owned button if open
  const modalBtn = document.getElementById('modal-owned-btn');
  if (modalBtn && modalBtn.dataset.cardId === cardId) {
    const nowOwned = owned.has(cardId);
    modalBtn.classList.toggle('is-owned', nowOwned);
    modalBtn.innerHTML = ownedBtnHtml(nowOwned);
  }
  if (currentTab === 'collection') renderCompletionBar();
}

function toggleCollect(card, btn, wrap) {
  const col = activeCol();
  if (!col) return;
  if (col.cards[card.id]) {
    delete col.cards[card.id];
    btn.textContent = '+ Add'; btn.classList.remove('collected');
    wrap.classList.remove('in-collection');
    wrap.querySelector('.in-collection-badge')?.remove();
  } else {
    col.cards[card.id] = card;
    btn.textContent = '✓ Added'; btn.classList.add('collected');
    wrap.classList.add('in-collection');
    if (!wrap.querySelector('.in-collection-badge')) {
      const badge = document.createElement('div');
      badge.className = 'in-collection-badge'; badge.textContent = '✓';
      wrap.prepend(badge);
    }
  }
  saveStore(); updateCount();
  if (currentTab === 'collection') renderCollectionsBar();
}

function ownedBtnHtml(isOwned) {
  return isOwned
    ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg> Owned`
    : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg> Mark as owned`;
}

// ── Modal ─────────────────────────────────────────────────────
function openModal(card) {
  const inner = document.getElementById('modal-inner');
  const attacks = (card.attacks || []).map(a => `
    <div class="attack-item">
      <div class="attack-name"><span>${a.name}</span><span class="attack-damage">${a.damage || ''}</span></div>
      ${a.text ? `<div class="attack-text">${a.text}</div>` : ''}
    </div>`).join('');

  // Build per-collection add rows
  const colRows = store.collections.map(col => {
    const inThis = !!col.cards[card.id];
    return `<div class="modal-col-row">
      <div>
        <div class="modal-col-row-name">${col.name}</div>
        <div class="modal-col-row-count">${Object.keys(col.cards).length} card${Object.keys(col.cards).length !== 1 ? 's' : ''}</div>
      </div>
      <button class="modal-add-btn ${inThis ? 'in-col' : ''}"
              onclick="toggleModalCollect(${JSON.stringify(card).replace(/"/g,'&quot;')}, '${col.id}')">
        ${inThis ? '✓ Added' : '+ Add'}
      </button>
    </div>`;
  }).join('');

  const isOwned = owned.has(card.id);

  inner.innerHTML = `
    <img class="modal-img" src="${card.images?.large || card.images?.small || ''}" alt="${card.name}" />
    <div class="modal-title">${card.name}</div>
    <div class="modal-meta">
      <div class="meta-item"><div class="meta-label">Set</div><div class="meta-value">${card.set?.name || '—'}</div></div>
      <div class="meta-item"><div class="meta-label">Number</div><div class="meta-value">${card.number ? `${card.number} / ${card.set?.printedTotal ?? card.set?.total ?? '?'}` : '—'}</div></div>
      <div class="meta-item"><div class="meta-label">Rarity</div><div class="meta-value">${card.rarity || '—'}</div></div>
      <div class="meta-item"><div class="meta-label">HP</div><div class="meta-value">${card.hp || '—'}</div></div>
      <div class="meta-item">
        <div class="meta-label">Market Price</div>
        <div class="meta-value" style="color:var(--accent)">${(() => { const p = getMarketPrice(card); return p !== null ? formatPrice(p) : '—'; })()}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Artist</div>
        <div class="meta-value">${card.artist
          ? `<span style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted;color:var(--accent)"
                   onclick="searchByArtist('${card.artist.replace(/'/g,"\\'")}')">${card.artist}</span>`
          : '—'}</div>
      </div>
    </div>
    ${attacks ? `<div class="attacks-list"><h4>Attacks</h4>${attacks}</div>` : ''}
    <button class="modal-owned-btn ${isOwned ? 'is-owned' : ''}" id="modal-owned-btn"
            data-card-id="${card.id}"
            onclick="toggleModalOwned('${card.id}')">
      ${ownedBtnHtml(isOwned)}
    </button>
    <a class="modal-share-btn"
       href="${card.tcgplayer?.url || `https://www.tcgplayer.com/search/pokemon/product?q=${encodeURIComponent(card.name)}&view=grid`}"
       target="_blank" rel="noopener noreferrer">
      <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
        <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
      </svg>
      View on TCGPlayer
    </a>
    <div class="modal-add-section">
      <div class="modal-add-label">Add to collection</div>
      <div class="modal-col-list">${colRows}</div>
    </div>`;

  document.getElementById('modal-overlay').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function toggleModalCollect(card, colId) {
  const col = store.collections.find(c => c.id === colId);
  if (!col) return;
  if (col.cards[card.id]) { delete col.cards[card.id]; }
  else { col.cards[card.id] = card; }
  saveStore(); updateCount();
  openModal(card); // re-render modal state
}

function toggleModalOwned(cardId) {
  const btn = document.getElementById('modal-owned-btn');
  if (owned.has(cardId)) {
    owned.delete(cardId);
    btn?.classList.remove('is-owned');
    if (btn) btn.innerHTML = ownedBtnHtml(false);
  } else {
    owned.add(cardId);
    btn?.classList.add('is-owned');
    if (btn) btn.innerHTML = ownedBtnHtml(true);
  }
  saveOwned();
  if (owned.has(cardId)) checkCollectionComplete(cardId);
  // Update any visible card in the grid
  if (lastResults.length) renderResults(lastResults);
  else if (currentTab === 'collection') renderCollectionGrid();
  if (currentTab === 'collection') renderCompletionBar();
}

function searchByArtist(artist) {
  closeModal();
  setSearchMode('artist');
  document.getElementById('search-input').value = artist;
  currentQuery = artist; currentPage = 1;
  switchTab('search');
  fetchCards();
}

// ── Deep-link: open card from ?card=<id> on page load ─────────
async function checkDeepLink() {
  const params = new URLSearchParams(window.location.search);
  const cardId = params.get('card');
  if (!cardId) return;
  // Clean URL without reloading
  history.replaceState(null, '', window.location.pathname);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (API_KEY) headers['X-Api-Key'] = API_KEY;
    const data = await cachedFetch(`${API}/cards/${encodeURIComponent(cardId)}`, headers, CACHE_TTL_CARDS);
    if (data.data) openModal(data.data);
  } catch {}
}
checkDeepLink();

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  document.body.style.overflow = '';
  if (currentTab === 'collection') renderCollectionTab();
  else if (lastResults.length) renderResults(lastResults);
}

function closeModalIfBg(e) {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
}

// ── Collection complete celebration ───────────────────────────
function checkCollectionComplete(newlyOwnedCardId) {
  // Find any collection where: this card exists AND all cards are now owned
  const completedCols = store.collections.filter(col => {
    const cardIds = Object.keys(col.cards);
    if (!cardIds.includes(newlyOwnedCardId)) return false;
    if (cardIds.length === 0) return false;
    return cardIds.every(id => owned.has(id));
  });
  if (completedCols.length > 0) {
    const names = completedCols.map(c => c.name).join(' & ');
    launchCelebration(names, completedCols[0].cards);
  }
}

let confettiAnim = null;

function launchCelebration(colName, cards) {
  const overlay = document.getElementById('celebrate-overlay');
  document.getElementById('celebrate-sub').textContent =
    `You now own every card in "${colName}" — all ${Object.keys(cards).length} of them!`;
  overlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  startConfetti();
}

function closeCelebration() {
  document.getElementById('celebrate-overlay').classList.add('hidden');
  document.body.style.overflow = '';
  if (confettiAnim) { cancelAnimationFrame(confettiAnim); confettiAnim = null; }
  const canvas = document.getElementById('confetti-canvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function startConfetti() {
  const canvas = document.getElementById('confetti-canvas');
  const ctx = canvas.getContext('2d');
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;

  const COLORS = ['#f5c518','#e84040','#3ddc84','#60a5fa','#c084fc','#fb923c','#ffffff'];
  const pieces = Array.from({ length: 120 }, () => ({
    x:    Math.random() * canvas.width,
    y:    Math.random() * canvas.height - canvas.height,
    w:    6 + Math.random() * 8,
    h:    10 + Math.random() * 6,
    r:    Math.random() * Math.PI * 2,
    dr:   (Math.random() - 0.5) * 0.15,
    vy:   3 + Math.random() * 4,
    vx:   (Math.random() - 0.5) * 2,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    opacity: 0.85 + Math.random() * 0.15,
  }));

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    pieces.forEach(p => {
      ctx.save();
      ctx.globalAlpha = p.opacity;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
      p.x  += p.vx;
      p.y  += p.vy;
      p.r  += p.dr;
      p.vy += 0.08; // gravity
      // Reset pieces that fall off screen
      if (p.y > canvas.height + 20) {
        p.y  = -20;
        p.x  = Math.random() * canvas.width;
        p.vy = 3 + Math.random() * 4;
      }
    });
    confettiAnim = requestAnimationFrame(draw);
  }
  draw();
}

// ── Persistence ───────────────────────────────────────────────
function loadStore() {
  try {
    const raw = localStorage.getItem('ptcg_store');
    if (raw) return JSON.parse(raw);
  } catch {}
  // Migrate old single-collection data
  try {
    const old = JSON.parse(localStorage.getItem('ptcg_collection') || '{}');
    const id = 'col_default';
    return { collections: [{ id, name: 'My Collection', cards: old }], activeId: id };
  } catch {}
  const id = 'col_default';
  return { collections: [{ id, name: 'My Collection', cards: {} }], activeId: id };
}

function saveStore() {
  localStorage.setItem('ptcg_store', JSON.stringify(store));
}

function loadOwned() {
  try {
    const raw = localStorage.getItem('ptcg_owned');
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
}

function saveOwned() {
  localStorage.setItem('ptcg_owned', JSON.stringify([...owned]));
}

function updateCount() {
  const total = store.collections.reduce((n, c) => n + Object.keys(c.cards).length, 0);
  document.getElementById('col-count').textContent = total;
}