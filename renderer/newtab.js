// @ts-nocheck — standalone script for the bundled new-tab page: it runs against the globals its own
// preload (src/preload/newtab.ts) exposes, not the app shell's testerBrowser API, and was never type-checked
// while it lived inline in newtab.html.
    const DEFAULT_TILES = [
      { id: '1', url: 'https://duckduckgo.com',         title: 'DuckDuckGo' },
      { id: '2', url: 'https://github.com',             title: 'GitHub' },
      { id: '3', url: 'https://developer.mozilla.org',  title: 'MDN' },
      { id: '4', url: 'https://stackoverflow.com',      title: 'Stack Overflow' },
      { id: '5', url: 'https://caniuse.com',            title: 'Can I Use' },
      { id: '6', url: 'https://regex101.com',           title: 'Regex 101' },
      { id: '7', url: 'https://jsonformatter.org',      title: 'JSON Formatter' },
      { id: '8', url: 'https://httpstatuses.io',        title: 'HTTP Status' },
    ];

    let tiles = [];

    // #340: tiles show the icon the app cached from the site itself (main process,
    // keyed by origin), else an initial-letter tile. Nothing is requested from a third party.
    let favicons = {};

    function originOf(url) {
      try { return new URL(url).origin; } catch { return ''; }
    }

    async function loadFavicons() {
      if (!window.speedDial || !window.speedDial.getFavicons) return;
      try { favicons = (await window.speedDial.getFavicons(tiles.map((t) => t.url))) || {}; } catch { favicons = {}; }
    }

    function makeFaviconEl(tile) {
      const src = favicons[originOf(tile.url)];
      if (!src) return makeInitialEl(tile);
      const img = document.createElement('img');
      img.className = 'tile-favicon';
      img.alt = '';
      img.src = src;
      img.onerror = () => img.replaceWith(makeInitialEl(tile));
      return img;
    }

    function makeInitialEl(tile) {
      const el = document.createElement('div');
      el.className = 'tile-initial';
      el.textContent = (tile.title[0] || '?').toUpperCase();
      return el;
    }

    function renderGrid() {
      const grid = document.getElementById('grid');
      grid.innerHTML = '';

      for (const tile of tiles) {
        const el = document.createElement('div');
        el.className = 'tile';
        el.title = tile.url;

        el.appendChild(makeFaviconEl(tile));

        const titleEl = document.createElement('div');
        titleEl.className = 'tile-title';
        titleEl.textContent = tile.title;
        el.appendChild(titleEl);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'tile-remove';
        removeBtn.title = 'Remove';
        removeBtn.setAttribute('aria-label', 'Remove site');
        removeBtn.textContent = '×';
        removeBtn.onclick = (e) => { e.stopPropagation(); removeTile(tile.id); };
        el.appendChild(removeBtn);

        el.onclick = () => { if (/^https?:\/\//i.test(tile.url)) window.location.href = tile.url; };
        grid.appendChild(el);
      }

      // Add tile
      const addEl = document.createElement('div');
      addEl.className = 'tile tile-add';
      const addIcon = document.createElement('span');
      addIcon.className = 'tile-add-icon';
      addIcon.textContent = '+';
      addEl.appendChild(addIcon);
      const addLabel = document.createElement('div');
      addLabel.className = 'tile-title';
      addLabel.textContent = 'Add site';
      addEl.appendChild(addLabel);
      addEl.onclick = () => openModal();
      grid.appendChild(addEl);
    }

    async function removeTile(id) {
      tiles = tiles.filter(t => t.id !== id);
      await persist();
      renderGrid();
    }

    async function addTile(url, title) {
      tiles.push({ id: String(Date.now()), url, title });
      await persist();
      renderGrid();
    }

    async function persist() {
      if (window.speedDial) await window.speedDial.saveTiles(tiles);
    }

    async function init() {
      if (window.speedDial) {
        try {
          const saved = await window.speedDial.getTiles();
          tiles = Array.isArray(saved) && saved.length > 0 ? saved : DEFAULT_TILES;
        } catch {
          tiles = DEFAULT_TILES;
        }
      } else {
        tiles = DEFAULT_TILES;
      }
      await loadFavicons();
      renderGrid();
    }

    // ── Modal ──
    function openModal() {
      document.getElementById('inputUrl').value = '';
      document.getElementById('inputTitle').value = '';
      document.getElementById('modal').hidden = false;
      document.getElementById('inputUrl').focus();
    }

    function closeModal() {
      document.getElementById('modal').hidden = true;
    }

    function confirmAdd() {
      const url   = document.getElementById('inputUrl').value.trim();
      const title = document.getElementById('inputTitle').value.trim();
      if (!url) { document.getElementById('inputUrl').focus(); return; }
      let finalTitle = title;
      if (!finalTitle) {
        try { finalTitle = new URL(url).hostname.replace(/^www\./, ''); } catch { finalTitle = url; }
      }
      addTile(url, finalTitle);
      closeModal();
    }

    document.getElementById('btnCancel').onclick = closeModal;
    document.getElementById('btnAdd').onclick    = confirmAdd;

    document.getElementById('modal').onclick = (e) => {
      if (e.target === document.getElementById('modal')) closeModal();
    };

    document.getElementById('inputUrl').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        // Auto-fill title then move to title field
        const url = e.target.value.trim();
        if (url && !document.getElementById('inputTitle').value) {
          try { document.getElementById('inputTitle').value = new URL(url).hostname.replace(/^www\./, ''); } catch {}
        }
        document.getElementById('inputTitle').focus();
      }
      if (e.key === 'Escape') closeModal();
    });

    document.getElementById('inputTitle').addEventListener('keydown', (e) => {
      if (e.key === 'Enter')  confirmAdd();
      if (e.key === 'Escape') closeModal();
    });

    init();

    // ── Search box (#317) ──
    const SEARCH_ENGINES = {
      google:     { name: 'Google',     url: 'https://www.google.com/search?q=' },
      duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
    };
    let searchEngine = 'google';

    // A bare host/URL goes there directly; anything else is a search query.
    function resolveSearchInput(raw) {
      const text = raw.trim();
      if (!text) return '';
      if (/^https?:\/\//i.test(text)) return text;
      if (!/\s/.test(text) && /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(text)) return 'https://' + text;
      return (SEARCH_ENGINES[searchEngine] || SEARCH_ENGINES.google).url + encodeURIComponent(text);
    }

    async function initSearch() {
      const input = document.getElementById('searchInput');
      const setPlaceholder = () => {
        input.placeholder = `Search ${(SEARCH_ENGINES[searchEngine] || SEARCH_ENGINES.google).name} or enter an address`;
      };
      setPlaceholder();
      if (window.appSettings) {
        try {
          const settings = await window.appSettings.get();
          if (settings && SEARCH_ENGINES[settings.searchEngine]) searchEngine = settings.searchEngine;
          setPlaceholder();
        } catch {}
      }
      document.getElementById('searchForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const target = resolveSearchInput(input.value);
        if (target) window.location.href = target;
      });
    }

    // ── Background customization ──
    const BG_KEY = 'newtabBg';
    const BG_PRESETS = [
      { bg: '#1a1a1a', label: 'Dark' },
      { bg: '#0d1117', label: 'GitHub dark' },
      { bg: '#1e2a3a', label: 'Navy' },
      { bg: '#1a1a2e', label: 'Midnight' },
      { bg: '#f5f5f5', label: 'Light' },
      { bg: 'linear-gradient(135deg,#1a1a2e,#16213e,#0f3460)', label: 'Deep blue' },
      { bg: 'linear-gradient(135deg,#0d0d0d,#1a1a1a,#2d2d2d)', label: 'Charcoal' },
      { bg: 'linear-gradient(135deg,#1a2a1a,#0d1a0d)', label: 'Forest' },
    ];

    function applyBg(bg) {
      if (bg.startsWith('#') || bg.startsWith('rgb')) {
        document.body.style.background = bg;
      } else {
        document.body.style.background = bg;
      }
    }

    function renderPresets() {
      const savedBg = (() => { try { return localStorage.getItem(BG_KEY) || '#1a1a1a'; } catch { return '#1a1a1a'; } })();
      const container = document.getElementById('bgPresets');
      container.innerHTML = '';
      for (const p of BG_PRESETS) {
        const el = document.createElement('div');
        el.className = 'bg-preset' + (p.bg === savedBg ? ' active' : '');
        el.style.background = p.bg;
        el.title = p.label;
        el.addEventListener('click', () => {
          try { localStorage.setItem(BG_KEY, p.bg); } catch {}
          applyBg(p.bg);
          renderPresets();
          document.getElementById('bgColorInput').value = '';
        });
        container.appendChild(el);
      }
    }

    (() => {
      let savedBg;
      try { savedBg = localStorage.getItem(BG_KEY); } catch {}
      if (savedBg) applyBg(savedBg);

      renderPresets();

      const btn = document.getElementById('bgSettingsBtn');
      const panel = document.getElementById('bgPanel');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        panel.classList.toggle('open');
      });
      document.addEventListener('click', () => { panel.classList.remove('open'); });
      panel.addEventListener('click', (e) => e.stopPropagation());

      document.getElementById('bgApplyBtn').addEventListener('click', () => {
        const val = document.getElementById('bgColorInput').value.trim();
        if (!val) return;
        try { localStorage.setItem(BG_KEY, val); } catch {}
        applyBg(val);
        renderPresets();
      });
    })();

    (function initTheme() {
      const apply = (scheme) => document.body.classList.toggle('light-mode', scheme === 'light');
      if (!window.appTheme) return;
      window.appTheme.get().then(apply).catch(() => {});
      window.appTheme.onChange(apply);
    })();

    initSearch();
