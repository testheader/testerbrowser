// @ts-nocheck — standalone script for the bundled new-tab page: it runs against the globals its own
// preload (src/preload/newtab.ts) exposes, not the app shell's testerBrowser API, and was never type-checked
// while it lived inline in newtab.html.
    const DEFAULT_TILES = [
      { id: '1', url: 'https://www.google.com',        title: 'Google' },
      { id: '2', url: 'https://github.com',             title: 'GitHub' },
      { id: '3', url: 'https://developer.mozilla.org',  title: 'MDN' },
      { id: '4', url: 'https://stackoverflow.com',      title: 'Stack Overflow' },
      { id: '5', url: 'https://caniuse.com',            title: 'Can I Use' },
      { id: '6', url: 'https://regex101.com',           title: 'Regex 101' },
      { id: '7', url: 'https://jsonformatter.org',      title: 'JSON Formatter' },
      { id: '8', url: 'https://httpstatuses.io',        title: 'HTTP Status' },
    ];

    let tiles = [];

    function faviconSrc(url) {
      try {
        const host = new URL(url).hostname;
        return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
      } catch { return ''; }
    }

    function makeFaviconEl(tile) {
      const src = faviconSrc(tile.url);
      if (!src) return makeInitialEl(tile);
      const img = document.createElement('img');
      img.className = 'tile-favicon';
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

    // ── Bookmarks panel ──
    function makeBookmarkFavicon(bm) {
      const src = faviconSrc(bm.url);
      if (!src) return makeBookmarkInitial(bm);
      const img = document.createElement('img');
      img.className = 'bm-row-favicon';
      img.src = src;
      img.onerror = () => img.replaceWith(makeBookmarkInitial(bm));
      return img;
    }

    function makeBookmarkInitial(bm) {
      const el = document.createElement('span');
      el.className = 'bm-row-initial';
      el.textContent = ((bm.title || bm.url)[0] || '?').toUpperCase();
      return el;
    }

    function makeBookmarkRow(bm) {
      const row = document.createElement('div');
      row.className = 'bm-row';
      row.title = bm.url;
      row.appendChild(makeBookmarkFavicon(bm));

      const label = document.createElement('span');
      label.className = 'bm-row-title';
      label.textContent = bm.title || bm.url;
      row.appendChild(label);

      const rm = document.createElement('button');
      rm.className = 'bm-row-remove';
      rm.textContent = '×';
      rm.title = 'Remove bookmark';
      rm.setAttribute('aria-label', 'Remove bookmark');
      rm.onclick = async (e) => {
        e.stopPropagation();
        await window.bookmarksApi.remove(bm.url);
        loadBookmarksPanel();
      };
      row.appendChild(rm);

      row.onclick = () => { if (/^https?:\/\//i.test(bm.url)) window.location.href = bm.url; };
      return row;
    }

    async function loadBookmarksPanel() {
      const listEl = document.getElementById('bookmarksList');
      if (!window.bookmarksApi) { listEl.innerHTML = '<div class="bm-empty">Not available</div>'; return; }

      const [bookmarks, folders] = await Promise.all([
        window.bookmarksApi.list(),
        window.bookmarksApi.listFolders(),
      ]);

      listEl.innerHTML = '';
      if (bookmarks.length === 0) {
        listEl.innerHTML = '<div class="bm-empty">No bookmarks yet — press Ctrl+D on a page to add one.</div>';
        return;
      }

      const folderIds = new Set(folders.map((f) => f.id));
      const topLevel  = bookmarks.filter((b) => !b.folderId || !folderIds.has(b.folderId));
      for (const bm of topLevel) listEl.appendChild(makeBookmarkRow(bm));

      for (const folder of folders) {
        const inFolder = bookmarks.filter((b) => b.folderId === folder.id);
        if (inFolder.length === 0) continue;
        const heading = document.createElement('div');
        heading.className = 'bm-folder-heading';
        heading.textContent = folder.name;
        listEl.appendChild(heading);
        for (const bm of inFolder) listEl.appendChild(makeBookmarkRow(bm));
      }
    }

    // ── Quick settings panel ──
    function initQuickSettingsTheme() {
      const group = document.getElementById('themeToggleGroup');
      const btns  = [...group.querySelectorAll('button')];
      const THEME_CHOICE_KEY = 'newtabThemeChoice';

      const setActive = (scheme) => btns.forEach((b) => b.classList.toggle('active', b.dataset.scheme === scheme));
      let choice;
      try { choice = localStorage.getItem(THEME_CHOICE_KEY); } catch {}
      setActive(choice || 'system');

      btns.forEach((btn) => btn.addEventListener('click', () => {
        const scheme = btn.dataset.scheme;
        try { localStorage.setItem(THEME_CHOICE_KEY, scheme); } catch {}
        setActive(scheme);
        // The shared theme store only tracks a light/dark binary, so "system" is
        // resolved to whichever it currently reads before persisting — the actual
        // class toggle happens reactively via the appTheme.onChange listener above.
        const resolved = scheme === 'system'
          ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
          : scheme;
        window.appTheme?.set?.(resolved);
      }));
    }

    async function initRedactToggle() {
      const toggle = document.getElementById('redactToggle');
      if (!window.appSettings) { toggle.disabled = true; return; }
      try {
        const settings = await window.appSettings.get();
        toggle.checked = !!settings.redactSensitiveHeaders;
      } catch {}
      toggle.addEventListener('change', () => {
        window.appSettings.set({ redactSensitiveHeaders: toggle.checked });
      });
    }

    async function initVersionInfo() {
      const versionEl = document.getElementById('qsVersion');
      const statusEl  = document.getElementById('qsUpdateStatus');
      if (!window.appInfo) return;
      try {
        const info = await window.appInfo.getVersionInfo();
        versionEl.textContent = info.current || '—';
        if (info.latest && info.latest !== info.current) {
          statusEl.textContent = `Update available: ${info.latest}`;
        } else if (info.status === 'downloaded') {
          statusEl.textContent = 'Update downloaded — restart the app to install';
        } else if (info.isPackaged) {
          statusEl.textContent = "You're up to date";
        }
      } catch {}
    }

    loadBookmarksPanel();
    initSearch();
    initQuickSettingsTheme();
    initRedactToggle();
    initVersionInfo();
  
