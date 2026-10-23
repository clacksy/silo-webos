/*
 * Silo webOS client — UI and remote control.
 *
 * Key codes handled: 37/38/39/40 arrows, 13 OK/Enter, 461 Back,
 * 415 Play, 19 Pause, 417 Fast-forward, 412 Rewind.
 */
(function () {
  'use strict';

  var api = new window.SiloApi();
  var $ = function (id) { return document.getElementById(id); };
  var APP_VERSION = '0.10.2';

  var state = {
    screen: 'connect',
    tab: 'quick',
    // connect screen
    connectFocus: 0,
    qcSecret: null,
    qcTimer: null,
    // rows (home + detail episodes)
    rows: [],
    rowIndex: 0,
    colIndex: 0,
    // grid
    gridCards: [],
    gridIndex: 0,
    gridCols: 6,
    gridView: null,
    gridStart: 0,
    gridTotal: 0,
    gridLoading: false,
    // detail
    detailItem: null,
    detailSources: [],
    detailSourceIndex: 0,
    detailPlayback: null,
    detailRow: 0, // 0 buttons, 1 season tabs, 2 episodes
    detailCol: 0,
    detailFrom: 'home',
    detailSeq: 0,
    episodeCards: [],
    // search
    searchCards: [],
    searchIndex: 0,
    searchSeq: 0,
    // player
    player: null,
    playerControls: false,
    playerFocus: 0,
    // settings
    settingsRows: [],
    settingsFocus: 0,
    serverInfo: null
  };

  /* ============================ settings state ============================ */

  var SETTINGS_KEY = 'silo.settings';
  var settings = {
    showResume: true, latestRows: 4, seekStep: 10, autoplayNext: true,
    subLang: '', subForced: false, audioLang: '', subSize: 50, subStyle: 'Shadow'
  };

  function loadSettings() {
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        Object.keys(settings).forEach(function (k) {
          if (parsed[k] !== undefined) settings[k] = parsed[k];
        });
      }
    } catch (e) { /* defaults are fine */ }
  }

  var SUB_SIZES = { 36: 'Small', 50: 'Medium', 64: 'Large', 80: 'Extra large' };

  function applySubtitleStyle() {
    var tag = $('cue-style');
    if (!tag) {
      tag = document.createElement('style');
      tag.id = 'cue-style';
      document.head.appendChild(tag);
    }
    var box = settings.subStyle === 'Box';
    tag.textContent = 'video::cue {' +
      'font-size:' + (Number(settings.subSize) || 50) + 'px;' +
      'color:#fff;line-height:1.3;' +
      'background:' + (box ? 'rgba(0,0,0,.72)' : 'transparent') + ';' +
      'text-shadow:' + (box ? 'none' : '0 0 4px #000,0 2px 3px #000,0 0 10px rgba(0,0,0,.8)') + ';}';
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }

  /* ============================ helpers ============================ */

  function show(name) {
    state.screen = name;
    var active = document.activeElement;
    if (active && active.tagName === 'INPUT') active.blur();
    // Reflect the screen in the document title: it is visible to DevOps tooling
    // over SSH (webapp-dev-tools /json), which makes remote diagnosis possible.
    try { document.title = 'Silo · ' + name; } catch (e) { /* ignore */ }
    ['connect', 'home', 'grid', 'detail', 'player', 'search', 'settings'].forEach(function (s) {
      $('screen-' + s).classList.toggle('active', s === name);
    });
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function clearFocus() {
    Array.prototype.forEach.call(document.querySelectorAll('.focused'), function (n) {
      n.classList.remove('focused');
    });
  }

  // Scroll `container` just enough to bring `node` fully into view. Using
  // getBoundingClientRect avoids depending on offsetParent chains.
  function ensureVisible(container, node) {
    if (!container || !node) return;
    var c = container.getBoundingClientRect();
    var r = node.getBoundingClientRect();
    var margin = 16;
    if (r.top < c.top + margin) {
      container.scrollTop += (r.top - c.top) - margin;
    } else if (r.bottom > c.bottom - margin) {
      container.scrollTop += (r.bottom - c.bottom) + margin;
    }
  }

  function error(msg) {
    var e = $('connect-error');
    if (e) e.textContent = msg || '';
  }

  // Visible failure reporting: with the app running on a TV, an invisible
  // console error is undebuggable, so surface it on screen.
  var fatalLines = [];
  function fatal(msg) {
    if (!msg) return;
    fatalLines.push(String(msg).slice(0, 300));
    if (fatalLines.length > 6) fatalLines.shift();
    var n = $('fatal');
    if (!n) return;
    n.classList.remove('hidden');
    n.textContent = fatalLines.join('\n');
  }

  window.addEventListener('error', function (e) {
    var where = '';
    if (e && e.filename) {
      where = ' @ ' + String(e.filename).split('/').pop() + ':' + e.lineno;
    }
    fatal('Error: ' + ((e && e.message) || 'script error') + where);
  });

  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    fatal('Promise: ' + ((r && r.message) || r || 'unhandled rejection'));
  });

  function fmtRuntime(ticks) {
    if (!ticks) return '';
    var mins = Math.round(ticks / 600000000);
    if (mins < 60) return mins + 'm';
    return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
  }

  function exitApp() {
    try {
      if (window.webOS && typeof window.webOS.platformBack === 'function') {
        window.webOS.platformBack();
      } else {
        window.close();
      }
    } catch (e) {
      try { window.close(); } catch (e2) { /* ignore */ }
    }
  }

  /* ============================ connect ============================ */

  function connectFocusables() {
    var list = [$('server-url')];
    list.push(document.querySelector('.tab[data-tab="quick"]'));
    list.push(document.querySelector('.tab[data-tab="pass"]'));
    if (state.tab === 'quick') {
      list.push($('qc-start'));
    } else {
      list.push($('username'), $('password'), $('pass-signin'));
    }
    return list.filter(function (n) { return n && n.offsetParent !== null; });
  }

  function connectSetFocus(i) {
    var list = connectFocusables();
    if (!list.length) return;
    state.connectFocus = Math.max(0, Math.min(list.length - 1, i));
    clearFocus();
    list[state.connectFocus].classList.add('focused');
  }

  function switchTab(tab) {
    state.tab = tab;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.classList.toggle('active', t.dataset.tab === tab);
    });
    ['quick', 'pass'].forEach(function (p) {
      $('pane-' + p).classList.toggle('active', p === tab);
    });
    error('');
    connectSetFocus(0);
  }

  function setQcStatus(msg) {
    var n = $('qc-status');
    if (n) n.textContent = msg;
  }

  function stopQuickConnect() {
    if (state.qcTimer) { clearInterval(state.qcTimer); state.qcTimer = null; }
    state.qcSecret = null;
  }

  async function startQuickConnect() {
    error('');
    stopQuickConnect();
    api.setServer($('server-url').value);
    if (!api.base) { error('Enter your server address first'); return; }

    try {
      var enabled = await api.quickConnectEnabled();
      if (!enabled) {
        error('Quick Connect is turned off on this server — use the Password tab');
        return;
      }
      var start = await api.quickConnectStart();
      if (!start || !start.Secret) { error('Could not start Quick Connect'); return; }
      state.qcSecret = start.Secret;
      $('qc-code').textContent = start.Code || '------';
      $('qc-url').textContent = api.base + '/activate';
      $('qc-code-wrap').classList.remove('hidden');
      setQcStatus('Waiting for approval…');

      state.qcTimer = setInterval(async function () {
        if (!state.qcSecret) return;
        try {
          var res = await api.quickConnectPoll(state.qcSecret);
          if (res && res.Authenticated) {
            stopQuickConnect();
            setQcStatus('Approved — signing in…');
            await api.quickConnectFinish(res.Secret || state.qcSecret);
            enterHome();
          }
        } catch (e) {
          /* keep polling; transient errors are normal */
        }
      }, 2500);
    } catch (e) {
      error(e.message || 'Quick Connect failed');
    }
  }

  async function signInWithPassword() {
    error('');
    api.setServer($('server-url').value);
    var u = $('username').value.trim();
    var p = $('password').value;
    if (!api.base) { error('Enter your server address first'); return; }
    if (!u || !p) { error('Enter your username and password'); return; }
    try {
      await api.signInWithPassword(u, p);
      enterHome();
    } catch (e) {
      error(e.message || 'Sign-in failed');
    }
  }

  function connectKey(code) {
    var list = connectFocusables();
    var cur = list[state.connectFocus];

    if (code === 38) { connectSetFocus(state.connectFocus - 1); return true; }
    if (code === 40) { connectSetFocus(state.connectFocus + 1); return true; }

    if (code === 37 || code === 39) {
      if (cur && cur.classList.contains('tab')) {
        switchTab(state.tab === 'quick' ? 'pass' : 'quick');
        return true;
      }
      if (code === 37) connectSetFocus(state.connectFocus - 1);
      else connectSetFocus(state.connectFocus + 1);
      return true;
    }

    if (code === 13) {
      if (!cur) return true;
      if (cur.classList.contains('tab')) {
        switchTab(cur.dataset.tab);
        return true;
      }
      if (cur.tagName === 'INPUT') {
        cur.focus(); // brings up the webOS on-screen keyboard
        return true;
      }
      cur.click();
      return true;
    }
    return false;
  }

  /* ============================ rows ============================ */

  function epCode(ep) {
    if (ep.ParentIndexNumber === undefined && ep.IndexNumber === undefined) return '';
    return 'S' + (ep.ParentIndexNumber || 0) + ':E' + (ep.IndexNumber || 0);
  }

  function cardTitle(item) {
    if (item.Type === 'Episode' && item.SeriesName) {
      return item.SeriesName + (epCode(item) ? ' · ' + epCode(item) : '');
    }
    return item.Name || 'Untitled';
  }

  function makeCard(item, opts) {
    opts = opts || {};
    var card = el('div', 'card' + (opts.wide ? ' wide' : '') + (opts.library ? ' library' : ''));
    if (!opts.library) {
      var img = document.createElement('img');
      img.loading = 'lazy';
      img.src = api.imageUrl(item.Id, 'Primary', opts.wide ? 300 : 460);
      img.onerror = function () { img.style.visibility = 'hidden'; };
      card.appendChild(img);
    }
    card.appendChild(el('div', 'card-label', cardTitle(item)));
    card.__item = item;
    return card;
  }

  function addRow(title, cards) {
    var rowEl = el('div', 'row');
    rowEl.appendChild(el('h2', 'row-title', title));
    var win = el('div', 'row-window');
    var track = el('div', 'row-track');
    cards.forEach(function (c) { track.appendChild(c); });
    win.appendChild(track);
    rowEl.appendChild(win);
    $('home-rows').appendChild(rowEl);
    return { el: rowEl, track: track, cards: cards };
  }

  function scrollRowTo(row, index) {
    var card = row.cards[index];
    if (!card) return;
    var offset = card.offsetLeft;
    var windowW = row.track.parentElement.clientWidth;
    var maxShift = Math.max(0, row.track.scrollWidth - windowW + 40);
    var shift = Math.max(0, offset - 80);
    shift = Math.min(shift, maxShift);
    row.track.style.transform = 'translateX(' + (-shift) + 'px)';
  }

  function rowSetFocus(rowIdx, colIdx) {
    if (!state.rows.length) return;
    state.rowIndex = Math.max(0, Math.min(state.rows.length - 1, rowIdx));
    var row = state.rows[state.rowIndex];
    state.colIndex = Math.max(0, Math.min(row.cards.length - 1, colIdx));
    clearFocus();
    row.cards[state.colIndex].classList.add('focused');
    scrollRowTo(row, state.colIndex);
    ensureVisible($('home-rows'), row.el);
  }

  function activateRowCard() {
    var row = state.rows[state.rowIndex];
    if (!row) return;
    var card = row.cards[state.colIndex];
    if (!card) return;
    var item = card.__item;
    if (item && item.__library) openGrid(item);
    else if (item && item.__search) openSearch();
    else if (item && item.__settings) openSettings();
    else if (item) openDetail(item.Id);
  }

  /* ============================ home ============================ */

  async function enterHome() {
    sessionExpired = false;
    state.addingProfile = null;
    rememberProfile();
    show('home');
    try { localStorage.removeItem('silo.signedOut'); } catch (e) { /* ignore */ }
    $('home-user').textContent = api.userName ? ('Signed in as ' + api.userName) : '';
    var rowsEl = $('home-rows');
    rowsEl.innerHTML = '';
    state.rows = [];
    state.rowIndex = 0;
    state.colIndex = 0;

    var status = el('div', 'hint dim');
    status.textContent = 'Loading your library…';
    rowsEl.appendChild(status);

    var seq = state.homeSeq = (state.homeSeq || 0) + 1;
    var views = [];
    try { views = await api.views(); } catch (e) { /* handled below */ }
    if (seq !== state.homeSeq) return;

    if (!views.length && !api.token) { rowsEl.removeChild(status); show('connect'); return; }

    // Every row at once: same requests as before, a fraction of the wait.
    var none = function () { return []; };
    var maxRows = Number(settings.latestRows) || 4;
    var shown = views.slice(0, maxRows);
    var results = await Promise.all([
      settings.showResume ? api.resumeItems(14).catch(none) : Promise.resolve([]),
      api.nextUp({ limit: 16 }).catch(none),
      api.favorites(16).catch(none),
      Promise.all(shown.map(function (v) { return api.latestItems(v.Id, 16).catch(none); })),
      state.serverInfo ? Promise.resolve(state.serverInfo) : api.publicInfo().catch(function () { return null; })
    ]);
    if (seq !== state.homeSeq || state.screen !== 'home') return;
    rowsEl.removeChild(status);
    state.serverInfo = results[4];

    var wide = function (i) { return makeCard(i, { wide: true }); };
    var tall = function (i) { return makeCard(i, {}); };
    if (results[0].length) state.rows.push(addRow('Continue watching', results[0].map(wide)));
    if (results[1].length) state.rows.push(addRow('Next up', results[1].map(wide)));
    if (results[2].length) state.rows.push(addRow('Favourites', results[2].map(tall)));
    shown.forEach(function (v, k) {
      if (results[3][k].length) state.rows.push(addRow('Recently added · ' + v.Name, results[3][k].map(tall)));
    });

    // Libraries
    if (views.length) {
      var libCards = views.map(function (v) {
        var c = el('div', 'card library');
        c.appendChild(el('div', 'card-label', v.Name));
        c.__item = { __library: true, Id: v.Id, Name: v.Name };
        return c;
      });
      var searchTile = el('div', 'card library search-tile');
      searchTile.appendChild(el('div', 'card-label', 'Search'));
      searchTile.__item = { __search: true };
      var settingsTile = el('div', 'card library settings-tile');
      settingsTile.appendChild(el('div', 'card-label', 'Settings'));
      settingsTile.__item = { __settings: true };
      libCards.unshift(settingsTile);
      libCards.unshift(searchTile);
      state.rows.push(addRow('Libraries', libCards));
    }

    if (!state.rows.length) {
      var empty = el('p', 'hint', 'No libraries were returned by the server.');
      rowsEl.appendChild(empty);
      return;
    }

    rowSetFocus(0, 0);
    try {
      document.title = 'Silo · home · ' + state.rows.length + ' rows · ' + (api.userName || '');
    } catch (e) { /* ignore */ }
  }

  function homeKey(code) {
    if (code === 38) {
      if (state.rowIndex === 0) return true;
      var keepCol = state.colIndex;
      rowSetFocus(state.rowIndex - 1, keepCol);
      return true;
    }
    if (code === 40) {
      if (state.rowIndex >= state.rows.length - 1) return true;
      rowSetFocus(state.rowIndex + 1, state.colIndex);
      return true;
    }
    if (code === 37) { rowSetFocus(state.rowIndex, state.colIndex - 1); return true; }
    if (code === 39) { rowSetFocus(state.rowIndex, state.colIndex + 1); return true; }
    if (code === 13) { activateRowCard(); return true; }
    return false;
  }

  /* ============================ library grid ============================ */

  var GRID_SORTS = [
    { label: 'Name', sortBy: 'SortName', sortOrder: 'Ascending' },
    { label: 'Date added', sortBy: 'DateCreated,SortName', sortOrder: 'Descending' },
    { label: 'Year', sortBy: 'ProductionYear,SortName', sortOrder: 'Descending' },
    { label: 'Rating', sortBy: 'CommunityRating,SortName', sortOrder: 'Descending' }
  ];
  var GRID_FILTERS = [
    { label: 'All' },
    { label: 'Unwatched', filters: 'IsUnplayed' },
    { label: 'Favourites', filters: 'IsFavorite' }
  ];
  var LETTERS = ['#'].concat('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));

  // Focus on the grid screen is one of: the chips row, the letters row, or a
  // card. `state.gridZone` says which; each keeps its own index.
  function openGrid(view) {
    show('grid');
    $('grid-title').textContent = view.Name || 'Library';
    state.gridView = view;
    state.gridSort = 0;
    state.gridFilter = 0;
    state.gridLetter = 0;
    state.gridChip = 0;
    state.gridLetterFocus = 0;
    state.gridGenre = null;
    renderGridTools();
    return reloadGrid();
  }

  function gridQuery() {
    var sort = GRID_SORTS[state.gridSort];
    var letter = LETTERS[state.gridLetter];
    return {
      sortBy: sort.sortBy,
      sortOrder: sort.sortOrder,
      filters: GRID_FILTERS[state.gridFilter].filters,
      genreIds: state.gridGenre ? state.gridGenre.Id : undefined,
      nameFrom: state.gridSort === 0 && letter !== '#' ? letter : undefined
    };
  }

  function renderGridTools() {
    $('gt-sort').textContent = 'Sort: ' + GRID_SORTS[state.gridSort].label;
    $('gt-filter').textContent = 'Show: ' + GRID_FILTERS[state.gridFilter].label;
    $('gt-genre').textContent = 'Genre: ' + (state.gridGenre ? state.gridGenre.Name : 'All');
    var letters = $('grid-letters');
    if (!letters.children.length) {
      LETTERS.forEach(function (l) { letters.appendChild(el('button', 'chip', l)); });
    }
    Array.prototype.forEach.call(letters.children, function (c, i) {
      c.classList.toggle('active', i === state.gridLetter);
    });
    letters.classList.toggle('hidden', state.gridSort !== 0);
  }

  async function reloadGrid() {
    $('grid').innerHTML = '';
    $('grid-count').textContent = '';
    state.gridCards = [];
    state.gridIndex = 0;
    state.gridStart = 0;
    state.gridTotal = 0;
    state.gridLoading = false;
    state.gridSeq = (state.gridSeq || 0) + 1;
    $('grid-wrap').scrollTop = 0;
    await loadGridPage();
    if (state.screen !== 'grid') return;
    if (state.gridCards.length) gridSetFocus(0);
    else gridToolsFocus('chips', state.gridChip);
  }

  async function loadGridPage() {
    if (!state.gridView || state.gridLoading) return;
    var seq = state.gridSeq;
    state.gridLoading = true;
    var page;
    try {
      page = await api.libraryPage(state.gridView.Id, state.gridStart, 120, gridQuery());
    } catch (e) {
      if (seq === state.gridSeq) state.gridLoading = false;
      return;
    }
    if (seq !== state.gridSeq) return;
    var items = page.Items || [];
    state.gridTotal = page.TotalRecordCount || 0;
    $('grid-count').textContent = state.gridTotal.toLocaleString() + ' titles';
    items.forEach(function (item) {
      var card = makeCard(item, {});
      card.classList.add('grid-card');
      $('grid').appendChild(card);
      state.gridCards.push(card);
    });
    state.gridStart += items.length;
    if (!state.gridCards.length) {
      $('grid').appendChild(el('p', 'hint', 'Nothing here.'));
    }
    state.gridLoading = false;
  }

  var genreCache = {};

  async function chooseGenre() {
    var view = state.gridView;
    var genres = genreCache[view.Id];
    if (!genres) {
      try { genres = await api.genres(view.Id); } catch (e) { return; }
      genreCache[view.Id] = genres;
    }
    if (state.screen !== 'grid' || state.gridView !== view) return;
    var current = state.gridGenre ? genres.findIndex(function (g) { return g.Id === state.gridGenre.Id; }) + 1 : 0;
    openPicker('Genre', ['All'].concat(genres.map(function (g) { return g.Name; })), current, function (i) {
      state.gridGenre = i > 0 ? genres[i - 1] : null;
      renderGridTools();
      reloadGrid().then(function () { if (state.screen === 'grid') gridToolsFocus('chips', 2); });
    });
  }

  // Posters far from the cursor are unloaded and reloaded when it comes back,
  // so a long scroll through a big library doesn't hold thousands of images.
  var KEEP_IMAGES = 240;
  function trimGridImages() {
    var at = state.gridIndex;
    state.gridCards.forEach(function (card, i) {
      var img = card.firstChild;
      if (!img || img.tagName !== 'IMG') return;
      var far = Math.abs(i - at) > KEEP_IMAGES;
      if (far && img.getAttribute('src')) {
        img.dataset.src = img.getAttribute('src');
        img.removeAttribute('src');
      } else if (!far && !img.getAttribute('src') && img.dataset.src) {
        img.setAttribute('src', img.dataset.src);
      }
    });
  }

  function gridSetFocus(i) {
    if (!state.gridCards.length) return;
    state.gridZone = 'cards';
    state.gridIndex = Math.max(0, Math.min(state.gridCards.length - 1, i));
    clearFocus();
    var card = state.gridCards[state.gridIndex];
    card.classList.add('focused');
    ensureVisible($('grid-wrap'), card);
    state.gridMoves = (state.gridMoves || 0) + 1;
    if (state.gridCards.length > KEEP_IMAGES * 2 && state.gridMoves % 12 === 0) trimGridImages();

    // Fetch the next page as the user approaches the end
    if (state.gridStart < state.gridTotal && state.gridIndex >= state.gridCards.length - 8) {
      loadGridPage();
    }
  }

  function gridToolsFocus(zone, i) {
    var list = zone === 'letters' ? $('grid-letters').children : $('grid-chips').children;
    var idx = Math.max(0, Math.min(list.length - 1, i));
    if (zone === 'letters') state.gridLetterFocus = idx; else state.gridChip = idx;
    state.gridZone = zone;
    clearFocus();
    list[idx].classList.add('focused');
  }

  function gridKey(code) {
    var cols = state.gridCols;
    var zone = state.gridZone;
    var lettersShown = state.gridSort === 0;

    if (zone === 'chips') {
      if (code === 37) { gridToolsFocus('chips', state.gridChip - 1); return true; }
      if (code === 39) { gridToolsFocus('chips', state.gridChip + 1); return true; }
      if (code === 40) {
        if (lettersShown) gridToolsFocus('letters', state.gridLetter);
        else gridSetFocus(0);
        return true;
      }
      if (code === 13 && state.gridChip === 2) { chooseGenre(); return true; }
      if (code === 13) {
        if (state.gridChip === 0) state.gridSort = (state.gridSort + 1) % GRID_SORTS.length;
        else state.gridFilter = (state.gridFilter + 1) % GRID_FILTERS.length;
        if (state.gridSort !== 0) state.gridLetter = 0;
        renderGridTools();
        reloadGrid().then(function () { if (state.screen === 'grid') gridToolsFocus('chips', state.gridChip); });
        return true;
      }
      return code === 38;
    }

    if (zone === 'letters') {
      if (code === 37) { gridToolsFocus('letters', state.gridLetterFocus - 1); return true; }
      if (code === 39) { gridToolsFocus('letters', state.gridLetterFocus + 1); return true; }
      if (code === 38) { gridToolsFocus('chips', state.gridChip); return true; }
      if (code === 40) { gridSetFocus(0); return true; }
      if (code === 13) {
        state.gridLetter = state.gridLetterFocus;
        renderGridTools();
        reloadGrid();
        return true;
      }
      return false;
    }

    if (code === 37) { gridSetFocus(state.gridIndex - 1); return true; }
    if (code === 39) { gridSetFocus(state.gridIndex + 1); return true; }
    if (code === 38) {
      if (state.gridIndex < cols) {
        if (lettersShown) gridToolsFocus('letters', state.gridLetter);
        else gridToolsFocus('chips', state.gridChip);
      } else {
        gridSetFocus(state.gridIndex - cols);
      }
      return true;
    }
    if (code === 40) { gridSetFocus(state.gridIndex + cols); return true; }
    if (code === 13) {
      var card = state.gridCards[state.gridIndex];
      if (card && card.__item) openDetail(card.__item.Id, 'grid');
      return true;
    }
    return false;
  }

  /* ============================ detail ============================ */

  function videoStreamOf(src) {
    var streams = (src && src.MediaStreams) || [];
    for (var i = 0; i < streams.length; i++) {
      if (streams[i].Type === 'Video') return streams[i];
    }
    return null;
  }

  function sourceLabel(src) {
    if (!src) return 'Default';
    if (src.Name) return src.Name;
    var v = videoStreamOf(src) || {};
    var parts = [];
    if (v.Height) parts.push(v.Height + 'p');
    var bitrate = src.BitRate || v.BitRate || 0;
    if (bitrate) parts.push((bitrate / 1000000).toFixed(1) + ' Mb/s');
    var streams = src.MediaStreams || [];
    for (var i = 0; i < streams.length; i++) {
      if (streams[i].Type === 'Audio' && streams[i].IsDefault && streams[i].Codec) {
        parts.push(String(streams[i].Codec).toUpperCase());
        break;
      }
    }
    return parts.join(' · ') || 'Default';
  }

  // Highest resolution first, then highest bitrate.
  function pickBestSource(sources) {
    if (!sources || !sources.length) return null;
    var best = sources[0];
    for (var i = 1; i < sources.length; i++) {
      var a = videoStreamOf(best) || {};
      var b = videoStreamOf(sources[i]) || {};
      var ha = a.Height || 0, hb = b.Height || 0;
      if (hb > ha) { best = sources[i]; continue; }
      if (hb === ha && (sources[i].BitRate || 0) > (best.BitRate || 0)) best = sources[i];
    }
    return best;
  }

  function cycleVersion() {
    var sources = state.detailSources;
    if (sources.length < 2) return;
    state.detailSourceIndex = (state.detailSourceIndex + 1) % sources.length;
    $('detail-version').textContent = 'Version: ' + sourceLabel(sources[state.detailSourceIndex]);
  }

  async function openDetail(id, from) {
    var seq = ++state.detailSeq;
    var current = function () { return seq === state.detailSeq && state.screen === 'detail'; };
    state.detailFrom = from || 'home';
    show('detail');
    $('detail-episodes').classList.add('hidden');
    $('episode-track').innerHTML = '';
    state.episodeCards = [];
    state.seasons = [];
    state.seasonEpisodes = {};
    state.seasonIndex = 0;
    state.detailRow = 0;
    state.detailCol = 0;
    $('season-tabs').innerHTML = '';
    state.detailSources = [];
    state.detailSourceIndex = 0;
    state.detailPlayback = null;
    $('detail-version').classList.add('hidden');

    var item = null;
    try { item = await api.item(id); } catch (e) { if (current()) handleBack(); return; }
    if (!current()) return;
    state.detailItem = item;

    var title = item.Name || '';
    if (item.Type === 'Episode' && item.SeriesName) {
      title = item.SeriesName + ' — ' + (item.Name || '');
    }
    $('detail-title').textContent = title;
    state.detailPlayTarget = item.Type === 'Series' ? null : item;
    $('detail-poster').src = api.imageUrl(item.Id, 'Primary', 640);
    $('detail-poster').onerror = function () { this.style.visibility = 'hidden'; };
    $('detail-bg').style.backgroundImage = 'url("' + api.backdropUrl(item.Id) + '")';

    var bits = [];
    if (item.Type === 'Episode' && epCode(item)) bits.push(epCode(item));
    if (item.ProductionYear) bits.push(item.ProductionYear);
    if (item.Type) bits.push(item.Type);
    if (item.RunTimeTicks) bits.push(fmtRuntime(item.RunTimeTicks));
    if (item.OfficialRating) bits.push(item.OfficialRating);
    if (item.CommunityRating) bits.push('★ ' + Number(item.CommunityRating).toFixed(1));
    $('detail-sub').textContent = bits.join('  ·  ');
    $('detail-overview').textContent = item.Overview || '';

    var ticks = item.UserData && item.UserData.PlaybackPositionTicks;
    $('detail-play').textContent = ticks ? ('Resume from ' + fmtRuntime(ticks)) : 'Play';

    var played = !!(item.UserData && item.UserData.Played);
    $('detail-watched').textContent = played ? 'Watched ✓' : 'Mark watched';
    var fav = !!(item.UserData && item.UserData.IsFavorite);
    $('detail-fav').textContent = fav ? '★ Favorite' : 'Add favorite';

    // Multiple versions (4K remux, 1080p, ...) — offer a picker, default to best
    if (item.Type !== 'Series') {
      try {
        var info = await api.playbackInfo(item.Id);
        if (!current()) return;
        var sources = (info && info.MediaSources) || [];
        if (sources.length > 1) {
          state.detailPlayback = info;
          state.detailSources = sources;
          var best = pickBestSource(sources);
          state.detailSourceIndex = Math.max(0, sources.indexOf(best));
          $('detail-version').textContent = 'Version: ' + sourceLabel(best);
          $('detail-version').classList.remove('hidden');
        }
      } catch (e) { /* single version or unavailable */ }
    }

    if (item.Type === 'Series') {
      await loadSeries(item, current);
      if (!current()) return;
    }

    if (current()) detailFocusRow(0, 0);
  }

  async function toggleWatched() {
    var it = state.detailItem;
    if (!it) return;
    var played = !(it.UserData && it.UserData.Played);
    try {
      await api.markPlayed(it.Id, played);
      it.UserData = it.UserData || {};
      it.UserData.Played = played;
      it.UserData.PlaybackPositionTicks = 0;
      $('detail-watched').textContent = played ? 'Watched ✓' : 'Mark watched';
      if (played) $('detail-play').textContent = 'Play';
    } catch (e) { /* leave the label unchanged */ }
  }

  async function toggleFavorite() {
    var it = state.detailItem;
    if (!it) return;
    var fav = !(it.UserData && it.UserData.IsFavorite);
    try {
      await api.setFavorite(it.Id, fav);
      it.UserData = it.UserData || {};
      it.UserData.IsFavorite = fav;
      $('detail-fav').textContent = fav ? '★ Favorite' : 'Add favorite';
    } catch (e) { /* leave the label unchanged */ }
  }

  /* ---------------- series: seasons and episodes ---------------- */

  // Play goes to Next Up (the episode to resume or watch next), and the season
  // holding it is selected; otherwise the first episode of the first season.
  async function loadSeries(series, current) {
    var seasons = [], next = null;
    try {
      var results = await Promise.all([api.seasons(series.Id), api.nextUp({ seriesId: series.Id, limit: 1 })]);
      seasons = results[0];
      next = results[1][0] || null;
    } catch (e) { /* no seasons */ }
    if (!current() || !seasons.length) return;

    state.seasons = seasons;
    var tabs = $('season-tabs');
    seasons.forEach(function (season) {
      tabs.appendChild(el('button', 'chip', season.Name || ('Season ' + season.IndexNumber)));
    });
    $('detail-episodes').classList.remove('hidden');

    var start = 0;
    for (var i = 0; i < seasons.length; i++) {
      if (next ? seasons[i].Id === next.SeasonId : seasons[i].IndexNumber > 0) { start = i; break; }
    }
    state.detailPlayTarget = next;
    await selectSeason(start, current);
    if (!current()) return;
    if (!next && state.episodeCards.length) state.detailPlayTarget = state.episodeCards[0].__item;
    updateSeriesPlayLabel();
    if (next) {
      var at = state.episodeCards.findIndex(function (c) { return c.__item.Id === next.Id; });
      state.detailCol = Math.max(0, at);
    }
  }

  function updateSeriesPlayLabel() {
    var target = state.detailPlayTarget;
    if (!target) { $('detail-play').textContent = 'Play'; return; }
    var ticks = target.UserData && target.UserData.PlaybackPositionTicks;
    var code = epCode(target);
    $('detail-play').textContent = ticks
      ? ('Resume ' + code + ' from ' + fmtRuntime(ticks))
      : ('Play ' + code);
  }

  async function selectSeason(i, current) {
    var season = state.seasons[i];
    if (!season) return;
    state.seasonIndex = i;
    Array.prototype.forEach.call($('season-tabs').children, function (t, k) {
      t.classList.toggle('active', k === i);
    });
    var eps = state.seasonEpisodes[season.Id];
    if (!eps) {
      try { eps = await api.episodes(state.detailItem.Id, season.Id); } catch (e) { eps = []; }
      state.seasonEpisodes[season.Id] = eps;
    }
    if ((current && !current()) || state.seasonIndex !== i) return;
    renderEpisodes(eps);
  }

  function renderEpisodes(eps) {
    var track = $('episode-track');
    track.innerHTML = '';
    track.style.transform = '';
    state.episodeCards = [];
    eps.forEach(function (ep) {
      var card = el('div', 'card wide');
      var img = document.createElement('img');
      img.loading = 'lazy';
      img.src = api.imageUrl(ep.Id, 'Primary', 300);
      img.onerror = function () { img.style.visibility = 'hidden'; };
      card.appendChild(img);
      var label = el('div', 'card-label', (ep.IndexNumber ? 'E' + ep.IndexNumber + ' · ' : '') + (ep.Name || 'Episode'));
      if (ep.UserData && ep.UserData.Played) label.appendChild(el('span', 'played', '✓'));
      card.appendChild(label);
      card.__item = ep;
      track.appendChild(card);
      state.episodeCards.push(card);
    });
  }

  // Re-read Next Up and the shown season after watching, so ticks and the
  // Play label are current. Two requests.
  async function refreshSeries() {
    var series = state.detailItem;
    if (!series || series.Type !== 'Series' || !state.seasons.length) return;
    var seq = state.detailSeq;
    var current = function () { return seq === state.detailSeq && state.screen === 'detail'; };
    var next = null;
    try { next = (await api.nextUp({ seriesId: series.Id, limit: 1 }))[0] || null; } catch (e) { return; }
    if (!current()) return;
    if (next) state.detailPlayTarget = next;
    var season = state.seasons[state.seasonIndex];
    delete state.seasonEpisodes[season.Id];
    await selectSeason(state.seasonIndex, current);
    if (!current()) return;
    updateSeriesPlayLabel();
    detailFocusRow(state.detailRow, state.detailCol);
  }

  /* ---------------- detail focus: buttons, seasons, episodes ---------------- */

  function detailButtons() {
    return [$('detail-play'), $('detail-watched'), $('detail-fav'), $('detail-version')]
      .filter(function (b) { return b && b.offsetParent !== null; });
  }

  function detailRowItems(row) {
    if (row === 0) return detailButtons();
    if (row === 1) return Array.prototype.slice.call($('season-tabs').children);
    return state.episodeCards;
  }

  function slideTrack(track, node) {
    var win = track.parentElement;
    var shift = Math.max(0, node.offsetLeft - 80);
    var maxShift = Math.max(0, track.scrollWidth - win.clientWidth + 40);
    track.style.transform = 'translateX(' + (-Math.min(shift, maxShift)) + 'px)';
  }

  function detailFocusRow(row, col) {
    var items = detailRowItems(row);
    if (!items.length) return;
    state.detailRow = row;
    state.detailCol = Math.max(0, Math.min(items.length - 1, col));
    clearFocus();
    var node = items[state.detailCol];
    node.classList.add('focused');
    if (row === 1) $('season-tabs').scrollLeft = Math.max(0, node.offsetLeft - 80);
    if (row === 2) slideTrack($('episode-track'), node);
  }

  var seasonTimer = null;

  function detailKey(code) {
    var row = state.detailRow;
    var col = state.detailCol;
    var rows = [0, 1, 2].filter(function (r) { return detailRowItems(r).length; });
    var at = rows.indexOf(row);

    if (code === 37 || code === 39) {
      detailFocusRow(row, col + (code === 39 ? 1 : -1));
      if (row === 1 && state.detailCol !== state.seasonIndex) {
        var pick = state.detailCol;
        clearTimeout(seasonTimer);
        seasonTimer = setTimeout(function () { selectSeason(pick); }, 350);
      }
      return true;
    }
    if (code === 38 || code === 40) {
      var nextRow = rows[at + (code === 40 ? 1 : -1)];
      if (nextRow === undefined) return true;
      detailFocusRow(nextRow, nextRow === 1 ? state.seasonIndex : 0);
      return true;
    }
    if (code === 13) {
      var node = detailRowItems(row)[col];
      if (row === 0 && node) node.click();
      if (row === 1) { clearTimeout(seasonTimer); selectSeason(col); }
      if (row === 2 && node && node.__item) playItem(node.__item);
      return true;
    }
    return false;
  }

  /* ============================ player ============================ */

  // The overlay (title, progress, time) fades after a few seconds of playback
  // and comes back on any key, on pause, and with any status message.
  var overlayTimer = null;

  function wakeOverlay() {
    var overlay = $('player-overlay');
    overlay.classList.remove('fade');
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(function () {
      if (state.screen !== 'player' || $('video').paused || state.playerControls ||
          state.picker || state.pendingNext || seek.target !== null) return;
      overlay.classList.add('fade');
      $('player-status').textContent = '';
    }, 4000);
  }

  function playerStatus(msg) {
    if (msg && state.screen === 'player') wakeOverlay();
    var n = $('player-status');
    if (n) n.textContent = msg || '';
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = Math.floor(sec % 60);
    var mm = m < 10 ? '0' + m : String(m);
    var ss = s < 10 ? '0' + s : String(s);
    return (h > 0 ? h + ':' + mm : String(m)) + ':' + ss;
  }

  function playerTick() {
    var v = $('video');
    var bar = $('po-bar');
    var time = $('po-time');
    var playBtn = $('pc-play');
    var dur = v.duration || 0;
    var pos = seek.target !== null ? seek.target : v.currentTime;
    if (bar) bar.style.width = (dur ? Math.min(100, (pos / dur) * 100) : 0) + '%';
    if (time) {
      var res = v.videoWidth ? ('  ·  ' + v.videoWidth + '\u00d7' + v.videoHeight) : '';
      time.textContent = fmtTime(pos) + '  /  ' + fmtTime(dur) + res;
    }
    if (playBtn) playBtn.textContent = v.paused ? 'Play' : 'Pause';
  }

  function playerControlList() {
    return [$('pc-prev'), $('pc-play'), $('pc-next'), $('pc-subs'), $('pc-audio'), $('pc-stop')]
      .filter(function (b) { return b && !b.classList.contains('hidden'); });
  }

  function playerSetFocus(i) {
    var list = playerControlList();
    if (!list.length) return;
    state.playerFocus = Math.max(0, Math.min(list.length - 1, i));
    clearFocus();
    list[state.playerFocus].classList.add('focused');
  }

  function playerShowControls(on) {
    state.playerControls = !!on;
    $('po-controls').classList.toggle('hidden', !on);
    if (on) playerSetFocus(state.playerFocus || 0);
    else clearFocus();
  }

  function togglePlay() {
    var v = $('video');
    if (v.paused) { v.play(); playerStatus(''); }
    else { v.pause(); playerStatus('Paused'); }
    playerTick();
  }

  // Presses (or a held key) in the same direction speed up: the seek step,
  // then 1, 5 and 10 minutes. The target is applied once the presses stop, so
  // a long scrub costs the server one new range request, not dozens.
  var seek = { target: null, dir: 0, since: 0, last: 0, timer: null };

  function fmtStep(sec) {
    return sec < 60 ? sec + 's' : (sec / 60) + ' min';
  }

  function skipBy(dir) {
    var v = $('video');
    var now = Date.now();
    if (now - seek.last < 120) return;
    if (dir !== seek.dir || now - seek.last > 700) { seek.since = now; seek.dir = dir; }
    seek.last = now;
    var held = now - seek.since;
    var base = Number(settings.seekStep) || 10;
    var step = held < 1500 ? base : held < 3500 ? Math.max(base, 60) : held < 6500 ? 300 : 600;
    var dur = v.duration || 0;
    var from = seek.target === null ? v.currentTime : seek.target;
    seek.target = Math.max(0, Math.min(dur ? dur - 1 : 1e9, from + dir * step));
    playerStatus((dir > 0 ? '» ' : '« ') + fmtTime(seek.target) + '   (' + (dir > 0 ? '+' : '−') + fmtStep(step) + ')');
    playerTick();
    clearTimeout(seek.timer);
    seek.timer = setTimeout(function () {
      if (seek.target !== null && state.player) v.currentTime = seek.target;
      seek.target = null;
      playerTick();
    }, 650);
  }

  function subtitleLabel() {
    var s = state.player;
    if (!s) return 'Subtitles';
    if (!s.subs || !s.subs.length) return 'No subtitles';
    if (s.subIndex < 0) return 'Subtitles: Off';
    var t = s.subs[s.subIndex] || {};
    var name = t.Language ? String(t.Language).toUpperCase() : ('Track ' + (s.subIndex + 1));
    return 'Subtitles: ' + name + (s.subs.length > 1 ? ' (' + (s.subIndex + 1) + '/' + s.subs.length + ')' : '');
  }

  function clearSubtitleTracks() {
    var v = $('video');
    Array.prototype.slice.call(v.querySelectorAll('track[data-sid]')).forEach(function (t) {
      var src = t.getAttribute('src') || '';
      if (src.indexOf('blob:') === 0) { try { URL.revokeObjectURL(src); } catch (e) { /* ignore */ } }
      if (t.parentNode) t.parentNode.removeChild(t);
    });
    state.subCues = 0;
    var s = state.player;
    if (s && s.mkvTracks) {
      Object.keys(s.mkvTracks).forEach(function (k) { if (s.mkvTracks[k]) s.mkvTracks[k].hide(); });
    }
  }

  // Embedded subtitles read straight from the MKV's own index (js/mkvsubs.js):
  // instant, and far lighter on the server than asking it to extract them.
  function mkvTrackFor(session, stream) {
    var key = String(stream.Index);
    if (session.mkvTracks[key] !== undefined) return Promise.resolve(session.mkvTracks[key]);
    if (!session.mkvFile) {
      session.mkvFile = window.MkvSubs.open(api.directStreamUrl(session.item.Id, session.source))
        .catch(function () { return null; });
    }
    return session.mkvFile.then(function (file) {
      if (session.mkvTracks[key] === undefined) {
        var track = null;
        try {
          track = file && window.MkvSubs.attach(file, stream.Index, $('video'),
            stream.DisplayTitle || stream.Language || 'Track', stream.Language);
        } catch (e) { /* fall back to server extraction */ }
        session.mkvTracks[key] = track || null;
      }
      return session.mkvTracks[key];
    });
  }

  // Text tracks are fetched with an opaque response unless the element is
  // CORS-enabled, which silently yields zero cues. Fetching the WebVTT here and
  // serving it as a blob URL makes it same-origin, so it always loads.
  // The server extracts every embedded text track of a file in one pass
  // (minutes for a large remux) and caches them all, so the first embedded
  // request is the only slow one; later ones wait for it, then return instantly.
  function subtitleTextFor(session, stream) {
    var key = String(stream.Index);
    if (session.subCache[key] !== undefined) return Promise.resolve(session.subCache[key]);
    if (session.subPending[key]) return session.subPending[key];

    var embedded = !stream.IsExternal;
    var ready = embedded && session.extraction
      ? session.extraction.catch(function () {})
      : Promise.resolve();

    var promise = ready.then(function () {
      return api.subtitleText(session.item.Id, session.source.Id, stream.Index);
    }).then(function (text) {
      session.subCache[key] = text;
      delete session.subPending[key];
      return text;
    }, function (err) {
      delete session.subPending[key];
      throw err;
    });
    session.subPending[key] = promise;
    if (embedded && !session.extraction) session.extraction = promise;
    return promise;
  }

  async function showSubtitle(index) {
    var s = state.player;
    if (!s) return;
    clearSubtitleTracks();
    if (index < 0) {
      var offBtn = $('pc-subs');
      if (offBtn) offBtn.textContent = subtitleLabel();
      playerStatus('Subtitles off');
      return;
    }
    var stream = s.subs[index];
    if (!stream || !s.source || !s.source.Id) {
      playerStatus('This file has no downloadable subtitles');
      return;
    }

    if (!stream.IsExternal && /mkv/i.test(s.source.Container || '')) {
      playerStatus('Loading subtitles…');
      var mkvTrack = await mkvTrackFor(s, stream);
      if (state.player !== s || s.subIndex !== index) return;
      if (mkvTrack) {
        mkvTrack.show();
        playerStatus('Subtitles on');
        var subsBtn = $('pc-subs');
        if (subsBtn) subsBtn.textContent = subtitleLabel();
        return;
      }
    }

    var key = String(stream.Index);
    var text = s.subCache[key];
    if (text === undefined) {
      var started = Date.now();
      playerStatus('Loading subtitles…');
      var ticker = setInterval(function () {
        var secs = Math.round((Date.now() - started) / 1000);
        playerStatus('Loading subtitles… ' + secs + 's (first time for this file can take ~3 min)');
      }, 1000);

      try {
        text = await subtitleTextFor(s, stream);
      } catch (e) {
        clearInterval(ticker);
        if (state.player !== s || s.subIndex !== index) return;
        playerStatus('Subtitles unavailable: ' + (e.message || 'error'));
        return;
      }
      clearInterval(ticker);
      if (state.player !== s || s.subIndex !== index) return;
    }

    if (!text || text.indexOf('WEBVTT') === -1) {
      playerStatus('Subtitle format is not text (needs burn-in)');
      return;
    }

    var blob = new Blob([text], { type: 'text/vtt' });
    var el = document.createElement('track');
    el.kind = 'subtitles';
    el.label = stream.DisplayTitle || stream.Language || 'Track';
    el.srclang = stream.Language || 'und';
    el.crossOrigin = 'anonymous';
    el.src = URL.createObjectURL(blob);
    el.setAttribute('data-sid', String(stream.Index));

    var video = $('video');
    video.appendChild(el);

    var enable = function () {
      try { el.track.mode = 'showing'; } catch (e) { /* ignore */ }
      var cues = el.track && el.track.cues ? el.track.cues.length : 0;
      state.subCues = cues;
      playerStatus(cues ? ('Subtitles on — ' + cues + ' cues') : 'Subtitles loaded, no cues found');
      try {
        var v = $('video');
        document.title = 'Silo · player · ' + (v.videoWidth || 0) + 'x' + (v.videoHeight || 0) +
          ' · cues ' + cues;
      } catch (e) { /* ignore */ }
    };
    el.addEventListener('load', enable);
    setTimeout(enable, 200);

    var btn = $('pc-subs');
    if (btn) btn.textContent = subtitleLabel();
  }

  function subtitleName(t) {
    return t.DisplayTitle || (t.Language ? String(t.Language).toUpperCase() : 'Unknown');
  }

  // The choice is remembered by language (and forced-ness) and applied to
  // whatever plays next.
  function chooseSubtitle() {
    var s = state.player;
    if (!s) return;
    if (!s.subs || !s.subs.length) {
      playerStatus('No text subtitles in this file');
      return;
    }
    var names = s.subs.map(subtitleName);
    var options = ['Off'].concat(names.map(function (n, i) {
      var same = names.filter(function (m) { return m === n; }).length;
      if (same < 2) return n;
      return n + '  ·  ' + (names.slice(0, i + 1).filter(function (m) { return m === n; }).length) + ' of ' + same;
    }));
    openPicker('Subtitles', options, s.subIndex + 1, function (i) {
      if (state.player !== s) return;
      s.subIndex = i - 1;
      var t = s.subs[s.subIndex];
      settings.subLang = t ? (t.Language || 'und') : '';
      settings.subForced = !!(t && t.IsForced);
      saveSettings();
      showSubtitle(s.subIndex);
    });
  }

  /* ---------------- audio tracks ---------------- */

  // The webOS player exposes the file's audio tracks (only those it can
  // decode, so there can be fewer than the server lists). Names come from the
  // server when the counts line up; otherwise language plus a number.
  function audioNames(session) {
    var tracks = $('video').audioTracks;
    var list = Array.prototype.slice.call(tracks || []);
    var server = session.audio || [];
    var lang = function (code) { return code ? String(code).toUpperCase() : 'Unknown'; };
    return list.map(function (t, i) {
      if (server.length === list.length) return server[i].DisplayTitle || lang(server[i].Language);
      var same = list.filter(function (u) { return u.language === t.language; });
      return lang(t.language) + (same.length > 1 ? ' ' + (same.indexOf(t) + 1) : '');
    });
  }

  function enableAudio(index) {
    var tracks = $('video').audioTracks;
    for (var i = 0; i < tracks.length; i++) tracks[i].enabled = i === index;
  }

  function setupAudio(session) {
    var tracks = $('video').audioTracks;
    var btn = $('pc-audio');
    var many = !!(tracks && tracks.length > 1);
    btn.classList.toggle('hidden', !many);
    if (!many) return;
    if (settings.audioLang) {
      for (var i = 0; i < tracks.length; i++) {
        if (tracks[i].language === settings.audioLang) {
          if (!tracks[i].enabled) enableAudio(i);
          break;
        }
      }
    }
    btn.textContent = 'Audio: ' + audioNames(session)[enabledAudio()];
  }

  function enabledAudio() {
    var tracks = $('video').audioTracks;
    for (var i = 0; i < tracks.length; i++) if (tracks[i].enabled) return i;
    return 0;
  }

  // Report which audio the viewer is actually hearing. The player switches
  // tracks locally, so without this the server session always claims the
  // file's default track.
  function serverAudioIndex(session) {
    if (!session) return undefined;
    var list = Array.prototype.slice.call($('video').audioTracks || []);
    var server = session.audio || [];
    if (!server.length) return undefined;
    if (list.length === server.length) {
      var enabled = enabledAudio();
      if (server[enabled] && server[enabled].Index !== undefined) return server[enabled].Index;
    }
    if (session.audioSwitched !== undefined) return session.audioSwitched;
    return server[0].Index;
  }

  function chooseAudio() {
    var s = state.player;
    var tracks = $('video').audioTracks;
    if (!s || !tracks || tracks.length < 2) return;
    var names = audioNames(s);
    openPicker('Audio', names, enabledAudio(), function (i) {
      if (state.player !== s) return;
      enableAudio(i);
      if (s.audio && s.audio[i]) s.audioSwitched = s.audio[i].Index;
      settings.audioLang = tracks[i].language || '';
      saveSettings();
      $('pc-audio').textContent = 'Audio: ' + names[i];
      playerStatus('Audio: ' + names[i]);
    });
  }

  function preferredSubtitle(subs) {
    if (!settings.subLang) return -1;
    var best = -1;
    for (var i = 0; i < subs.length; i++) {
      var t = subs[i];
      if ((t.Language || 'und') !== settings.subLang) continue;
      if (!!t.IsForced === !!settings.subForced) return i;
      if (best < 0) best = i;
    }
    return best;
  }

  async function playItem(item) {
    show('player');
    var video = $('video');
    $('player-title').textContent = item.SeriesName
      ? item.SeriesName + ' — ' + (item.Name || '')
      : (item.Name || '');
    playerStatus('Starting…');
    playerShowControls(false);
    playerTick();

    var info = null;
    var source = null;
    if (state.detailItem && state.detailItem.Id === item.Id && state.detailSources.length) {
      info = state.detailPlayback;
      source = state.detailSources[state.detailSourceIndex] || null;
    }
    if (!info) {
      try { info = await api.playbackInfo(item.Id); } catch (e) { /* fall back below */ }
      if (state.screen !== 'player') return;
    }
    if (!source) source = pickBestSource((info && info.MediaSources) || []);
    var streams = (source && source.MediaStreams) || [];
    var subs = streams.filter(function (s) {
      return s.Type === 'Subtitle' && s.IsTextSubtitleStream !== false;
    });
    var audio = streams.filter(function (s) { return s.Type === 'Audio'; });

    var session = {
      item: item,
      source: source,
      subs: subs,
      audio: audio,
      subIndex: -1,
      subCache: {},
      subPending: {},
      mkvFile: null,
      mkvTracks: {},
      playSessionId: (info && info.PlaySessionId) || '',
      reported: false,
      timer: null,
      ticker: null,
      hlsTried: false,
      onMeta: null,
      lastGood: 0,
      retries: 0,
      segments: [],
      skipped: {}
    };
    api.mediaSegments(item.Id).then(function (list) { session.segments = list; }, function () { /* none */ });
    state.player = session;
    state.playerFocus = 0;

    clearSubtitleTracks();
    var subsBtn = $('pc-subs');
    if (subsBtn) subsBtn.textContent = subtitleLabel();

    $('pc-audio').classList.add('hidden');

    var startSeconds = 0;
    if (item.UserData && item.UserData.PlaybackPositionTicks) {
      startSeconds = window.SiloApi.ticksToSeconds(item.UserData.PlaybackPositionTicks);
    } else if (info && info.StartTimeTicks) {
      startSeconds = window.SiloApi.ticksToSeconds(info.StartTimeTicks);
    }

    function begin(url, at) {
      if (session.onMeta) video.removeEventListener('loadedmetadata', session.onMeta);
      video.src = url;
      video.load();
      session.onMeta = function () {
        video.removeEventListener('loadedmetadata', session.onMeta);
        session.onMeta = null;
        if (at > 2 && at < video.duration - 5) {
          video.currentTime = at;
        }
        setupAudio(session);
        var p = video.play();
        if (p && p.catch) p.catch(function () { playerStatus('Press OK to start playback'); });
        // Report the decoded resolution in the title so it can be read over SSH
        try {
          document.title = 'Silo \u00b7 player \u00b7 ' +
            (video.videoWidth || 0) + 'x' + (video.videoHeight || 0);
        } catch (e) { /* ignore */ }
        playerTick();
      };
      video.addEventListener('loadedmetadata', session.onMeta);
    }

    // A dropout mid-film reconnects at the last good position, backing off,
    // at most three times. HLS is only tried where the server can transcode.
    video.onerror = function () {
      if (state.player !== session) return;
      if (session.lastGood > 0 && session.retries < 3) {
        session.retries++;
        playerStatus('Connection lost — reconnecting…');
        var resumeAt = session.lastGood;
        setTimeout(function () {
          if (state.player === session) begin(api.directStreamUrl(item.Id, source), resumeAt);
        }, 2000 * session.retries);
        return;
      }
      if (!session.hlsTried && source && source.SupportsTranscoding) {
        session.hlsTried = true;
        playerStatus('Direct play unsupported — transcoding…');
        begin(api.hlsStreamUrl(item.Id, source), startSeconds);
        return;
      }
      playerStatus('Playback failed. Press Back to return.');
    };

    video.onwaiting = function () {
      if (state.player === session && seek.target === null) playerStatus('Buffering…');
    };

    video.onended = function () {
      if (state.player !== session) return;
      if (item.Type === 'Episode' && settings.autoplayNext) { playNextAfter(session); return; }
      stopPlayback('detail');
      refreshSeries();
    };

    video.onplaying = function () {
      wakeOverlay();
      playerStatus('');
      if (!session.autoSub) {
        session.autoSub = true;
        var pref = preferredSubtitle(session.subs);
        if (pref >= 0) { session.subIndex = pref; showSubtitle(pref); }
      }
      if (!session.reported) {
        session.reported = true;
        api.reportPlaying({
          ItemId: item.Id,
          MediaSourceId: source && source.Id,
          PlaySessionId: session.playSessionId,
          CanSeek: true,
          IsPaused: false,
          IsMuted: video.muted,
          VolumeLevel: Math.round(video.volume * 100),
          AudioStreamIndex: serverAudioIndex(session),
          PlayMethod: 'DirectPlay'
        });
      }
      clearInterval(session.timer);
      session.timer = setInterval(function () {
        api.reportProgress({
          ItemId: item.Id,
          MediaSourceId: source && source.Id,
          PlaySessionId: session.playSessionId,
          CanSeek: true,
          IsPaused: video.paused,
          PositionTicks: api.toTicks(video.currentTime),
          IsMuted: video.muted,
          VolumeLevel: Math.round(video.volume * 100),
          AudioStreamIndex: serverAudioIndex(session),
          PlayMethod: 'DirectPlay'
        });
      }, 10000);
      clearInterval(session.ticker);
      session.ticker = setInterval(playerTick, 500);
    };

    video.ontimeupdate = function () {
      if (video.currentTime > 0) session.lastGood = video.currentTime;
      updateSkip(session);
      playerTick();
    };
    video.onpause = function () {
      playerTick();
      wakeOverlay();
    };

    begin(api.directStreamUrl(item.Id, source), startSeconds);
  }

  function stopPlayback(returnTo) {
    var s = state.player;
    var video = $('video');
    if (s) {
      clearSubtitleTracks();
      if (s.timer) clearInterval(s.timer);
      if (s.ticker) clearInterval(s.ticker);
      if (s.onMeta) video.removeEventListener('loadedmetadata', s.onMeta);
      var dur = video.duration || 0;
      var finished = dur > 0 && (video.currentTime || 0) / dur > 0.9;
      var stoppedTicks = api.toTicks(video.currentTime || 0);
      api.reportStopped({
        ItemId: s.item.Id,
        MediaSourceId: s.source && s.source.Id,
        PlaySessionId: s.playSessionId,
        PositionTicks: stoppedTicks
      });
      s.item.UserData = s.item.UserData || {};
      s.item.UserData.PlaybackPositionTicks = finished ? 0 : stoppedTicks;
      if (finished) s.item.UserData.Played = true;
      if (state.detailItem === s.item) {
        var left = s.item.UserData.PlaybackPositionTicks;
        $('detail-play').textContent = left ? ('Resume from ' + fmtRuntime(left)) : 'Play';
        if (finished) $('detail-watched').textContent = 'Watched ✓';
      }
      state.player = null;
    }
    clearTimeout(seek.timer);
    seek.target = null;
    $('skip-btn').classList.add('hidden');
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (returnTo) show(returnTo);
  }

  /* ---------------- skip intro / credits ---------------- */

  var SKIP_LABELS = { Intro: 'Skip intro', Recap: 'Skip recap', Preview: 'Skip preview', Outro: 'Skip credits' };

  // The segment being offered, if playback is inside one that hasn't been
  // skipped. OK (with the controls hidden) takes it.
  function updateSkip(session) {
    var t = $('video').currentTime;
    var offer = null;
    session.segments.forEach(function (seg, i) {
      var start = seg.StartTicks / 1e7, end = seg.EndTicks / 1e7;
      if (SKIP_LABELS[seg.Type] && !session.skipped[i] && t >= start && t < end - 1) offer = { index: i, seg: seg };
    });
    session.offer = offer;
    var btn = $('skip-btn');
    if (!offer) { btn.classList.add('hidden'); return; }
    var outroNext = offer.seg.Type === 'Outro' && session.item.Type === 'Episode' && settings.autoplayNext;
    btn.textContent = (outroNext ? 'Next episode' : SKIP_LABELS[offer.seg.Type]) + '  ·  OK';
    btn.classList.remove('hidden');
  }

  function takeSkip() {
    var s = state.player;
    if (!s || !s.offer) return false;
    var offer = s.offer;
    s.skipped[offer.index] = true;
    s.offer = null;
    $('skip-btn').classList.add('hidden');
    if (offer.seg.Type === 'Outro' && s.item.Type === 'Episode' && settings.autoplayNext) {
      playNextAfter(s);
    } else {
      $('video').currentTime = offer.seg.EndTicks / 1e7;
    }
    return true;
  }

  /* ---------------- next episode ---------------- */

  async function playNextAfter(session) {
    var ep = session.item;
    stopPlayback(null);
    var next = null;
    try { next = await api.nextEpisode(ep); } catch (e) { /* treat as the end */ }
    if (state.screen !== 'player' || state.player) return;
    if (!next) {
      show('detail');
      refreshSeries();
      return;
    }
    var left = 10;
    var label = 'Next: ' + epCode(next) + ' ' + (next.Name || '');
    var tick = function () {
      playerStatus(label + ' — starts in ' + left + 's  ·  OK to play now  ·  Back to cancel');
    };
    tick();
    state.pendingNext = {
      item: next,
      timer: setInterval(function () {
        left--;
        if (left <= 0) startPendingNext(); else tick();
      }, 1000)
    };
  }

  function startPendingNext() {
    var p = state.pendingNext;
    if (!p) return;
    clearInterval(p.timer);
    state.pendingNext = null;
    playItem(p.item);
  }

  function cancelPendingNext() {
    var p = state.pendingNext;
    if (!p) return;
    clearInterval(p.timer);
    state.pendingNext = null;
  }

  function playerKey(code) {
    if (state.pendingNext) {
      if (code === 13) startPendingNext();
      return true;
    }
    if (state.playerControls) {
      if (code === 37) { playerSetFocus(state.playerFocus - 1); return true; }
      if (code === 39) { playerSetFocus(state.playerFocus + 1); return true; }
      if (code === 38 || code === 40) { playerShowControls(false); return true; }
      if (code === 13) {
        var btn = playerControlList()[state.playerFocus];
        if (btn) btn.click();
        return true;
      }
    } else if (code === 40) {
      playerShowControls(true);
      return true;
    }

    if (code === 13 && takeSkip()) return true;
    if (code === 13 || code === 415 || code === 19) { togglePlay(); return true; }
    if (code === 39 || code === 417) { skipBy(1); return true; }
    if (code === 37 || code === 412) { skipBy(-1); return true; }
    return false;
  }

  /* ============================ settings screen ============================ */

  function signOutNow() {
    var gone = api.userId;
    api.signOut();
    forgetProfile(gone);
    var rest = loadProfiles();
    if (rest.length) { useProfile(rest[0]); return; }
    try { localStorage.setItem('silo.signedOut', '1'); } catch (e) { /* ignore */ }
    resetForProfile();
    show('connect');
    connectSetFocus(0);
  }

  /* ============================ profiles ============================ */

  // Each Silo profile is its own sign-in (Quick Connect asks which profile to
  // approve), so every session is kept and switching just swaps tokens.
  var PROFILES_KEY = 'silo.profiles';

  function loadProfiles() {
    try { return JSON.parse(localStorage.getItem(PROFILES_KEY)) || []; } catch (e) { return []; }
  }

  function saveProfiles(list) {
    try { localStorage.setItem(PROFILES_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
  }

  function currentProfile() {
    return { server: api.base, token: api.token, userId: api.userId, userName: api.userName };
  }

  function rememberProfile() {
    if (!api.token || !api.userId) return;
    var list = loadProfiles().filter(function (p) { return p.userId !== api.userId; });
    list.unshift(currentProfile());
    saveProfiles(list);
  }

  function forgetProfile(userId) {
    saveProfiles(loadProfiles().filter(function (p) { return p.userId !== userId; }));
  }

  function profileName(p) {
    var name = (p && p.userName) || 'Profile';
    var hash = name.indexOf('#');
    return hash >= 0 ? name.slice(hash + 1) : name;
  }

  function resetForProfile() {
    state.rows = [];
    state.serverInfo = null;
    state.detailItem = null;
    state.gridView = null;
  }

  function useProfile(p) {
    api.setServer(p.server);
    api.token = p.token;
    api.userId = p.userId;
    api.userName = p.userName;
    api.persist();
    resetForProfile();
    enterHome();
  }

  function chooseProfile() {
    var list = loadProfiles();
    var names = list.map(function (p) {
      return profileName(p) + (p.userId === api.userId ? '  (current)' : '');
    });
    names.push('Add another profile…');
    var at = list.findIndex(function (p) { return p.userId === api.userId; });
    openPicker('Profiles', names, at, function (i) {
      if (i === list.length) { addProfile(); return; }
      if (list[i].userId !== api.userId) useProfile(list[i]);
    });
  }

  function addProfile() {
    state.addingProfile = currentProfile();
    api.signOut();
    resetForProfile();
    show('connect');
    switchTab('quick');
    error('Approve the code for the other profile. Back returns to ' + profileName(state.addingProfile) + '.');
  }

  function settingEntries() {
    var info = state.serverInfo || {};
    return [
      { type: 'header', label: 'Account' },
      { type: 'action', label: 'Profile', value: profileName(currentProfile()) + ' — OK to switch or add', run: chooseProfile },
      { type: 'info', label: 'Server', value: (info.ServerName || 'Silo') + (info.Version ? '  ·  ' + info.Version : '') },
      { type: 'action', label: 'Sign out of this profile', run: signOutNow },
      { type: 'header', label: 'Home screen' },
      { type: 'toggle', label: 'Continue watching', key: 'showResume' },
      { type: 'choice', label: 'Recently added rows', key: 'latestRows', options: [2, 4, 6], fmt: function (v) { return v + ' libraries'; } },
      { type: 'header', label: 'Playback' },
      { type: 'choice', label: 'Seek step', key: 'seekStep', options: [10, 30, 60], fmt: function (v) { return v + ' seconds'; } },
      { type: 'toggle', label: 'Play next episode automatically', key: 'autoplayNext' },
      { type: 'choice', label: 'Subtitle size', key: 'subSize', options: [36, 50, 64, 80], fmt: function (v) { return SUB_SIZES[v] || (v + 'px'); } },
      { type: 'choice', label: 'Subtitle style', key: 'subStyle', options: ['Shadow', 'Box'] },
      {
        type: 'action',
        label: 'Subtitles turn on automatically',
        value: settings.subLang ? String(settings.subLang).toUpperCase() + (settings.subForced ? ' (forced)' : '') + ' — OK to turn off' : 'Off',
        run: function () {
          settings.subLang = '';
          saveSettings();
          var f = state.settingsFocus;
          openSettings();
          settingsSetFocus(f);
        }
      },
      {
        type: 'action',
        label: 'Preferred audio language',
        value: settings.audioLang ? String(settings.audioLang).toUpperCase() + ' — OK to clear' : 'File default',
        run: function () {
          settings.audioLang = '';
          saveSettings();
          var f = state.settingsFocus;
          openSettings();
          settingsSetFocus(f);
        }
      },
      { type: 'header', label: 'About' },
      { type: 'info', label: 'App version', value: APP_VERSION },
      { type: 'info', label: 'Device ID', value: api.deviceId },
      { type: 'action', label: 'Reload app', run: function () { location.reload(); } }
    ];
  }

  function settingDisplay(e) {
    if (e.type === 'toggle') return settings[e.key] ? 'On' : 'Off';
    if (e.type === 'choice') return e.fmt ? e.fmt(settings[e.key]) : String(settings[e.key]);
    return e.value || '';
  }

  function openSettings() {
    show('settings');
    var list = $('settings-list');
    list.innerHTML = '';
    state.settingsRows = [];

    settingEntries().forEach(function (e) {
      if (e.type === 'header') {
        list.appendChild(el('div', 'set-header', e.label));
        return;
      }
      var rowEl = el('div', 'set-row' + (e.type === 'info' ? ' is-info' : ''));
      rowEl.appendChild(el('span', 'set-label', e.label));
      var valueEl = el('span', 'set-value', settingDisplay(e));
      rowEl.appendChild(valueEl);
      list.appendChild(rowEl);
      state.settingsRows.push({
        entry: e,
        el: rowEl,
        valueEl: valueEl,
        focusable: e.type === 'action' || e.type === 'toggle' || e.type === 'choice'
      });
    });

    settingsSetFocus(0);
  }

  function settingsFocusables() {
    return state.settingsRows.filter(function (r) { return r.focusable; });
  }

  function settingsSetFocus(i) {
    var list = settingsFocusables();
    if (!list.length) return;
    state.settingsFocus = Math.max(0, Math.min(list.length - 1, i));
    clearFocus();
    var row = list[state.settingsFocus];
    row.el.classList.add('focused');
    ensureVisible($('settings-list'), row.el);
  }

  function changeSetting(row, direction) {
    var e = row.entry;
    if (e.type === 'toggle') {
      settings[e.key] = !settings[e.key];
    } else if (e.type === 'choice') {
      var idx = e.options.indexOf(settings[e.key]);
      if (idx === -1) idx = 0;
      idx = (idx + direction + e.options.length) % e.options.length;
      settings[e.key] = e.options[idx];
    }
    saveSettings();
    if (e.key === 'subSize' || e.key === 'subStyle') applySubtitleStyle();
    row.valueEl.textContent = settingDisplay(e);
  }

  function settingsKey(code) {
    if (code === 38) { settingsSetFocus(state.settingsFocus - 1); return true; }
    if (code === 40) { settingsSetFocus(state.settingsFocus + 1); return true; }
    var list = settingsFocusables();
    var row = list[state.settingsFocus];
    if (!row) return false;
    if (code === 37) { changeSetting(row, -1); return true; }
    if (code === 39) { changeSetting(row, 1); return true; }
    if (code === 13) {
      if (row.entry.type === 'action') { row.entry.run(); return true; }
      changeSetting(row, 1);
      return true;
    }
    return false;
  }

  /* ============================ search ============================ */

  function openSearch() {
    show('search');
    var input = $('search-input');
    input.value = '';
    $('search-grid').innerHTML = '';
    $('search-hint').textContent = 'Type a title, then press OK';
    state.searchCards = [];
    state.searchIndex = 0;
    state.searchSeq++;
    focusSearchInput();
  }

  function focusSearchInput() {
    clearFocus();
    $('search-input').focus(); // raises the webOS on-screen keyboard
  }

  async function runSearch(term) {
    term = (term || '').trim();
    if (!term) return;
    var seq = ++state.searchSeq;
    var grid = $('search-grid');
    grid.innerHTML = '';
    state.searchCards = [];
    state.searchIndex = 0;
    $('search-hint').textContent = 'Searching…';

    var items = [];
    try {
      items = await api.search(term, 60);
    } catch (e) {
      if (seq !== state.searchSeq) return;
      $('search-hint').textContent = 'Search failed: ' + (e.message || 'unknown error');
      return;
    }
    if (seq !== state.searchSeq) return;

    $('search-hint').textContent = items.length
      ? (items.length + ' result' + (items.length === 1 ? '' : 's') + ' for "' + term + '"')
      : ('No results for "' + term + '"');

    items.forEach(function (item) {
      var card = makeCard(item, {});
      card.classList.add('grid-card');
      card.__item = item;
      grid.appendChild(card);
      state.searchCards.push(card);
    });

    $('search-input').blur();
    if (state.searchCards.length) searchSetFocus(0);
  }

  function searchSetFocus(i) {
    if (!state.searchCards.length) return;
    state.searchIndex = Math.max(0, Math.min(state.searchCards.length - 1, i));
    clearFocus();
    var card = state.searchCards[state.searchIndex];
    card.classList.add('focused');
    ensureVisible($('search-wrap'), card);
  }

  function searchKey(code) {
    var input = $('search-input');
    if (document.activeElement === input) {
      if (code === 13) { runSearch(input.value); return true; }
      return false; // the on-screen keyboard owns every other key
    }
    if (code === 13) {
      var card = state.searchCards[state.searchIndex];
      if (card && card.__item) openDetail(card.__item.Id, 'search');
      else focusSearchInput();
      return true;
    }
    if (code === 37) { searchSetFocus(state.searchIndex - 1); return true; }
    if (code === 39) { searchSetFocus(state.searchIndex + 1); return true; }
    if (code === 38) {
      if (state.searchIndex < state.gridCols) focusSearchInput();
      else searchSetFocus(state.searchIndex - state.gridCols);
      return true;
    }
    if (code === 40) { searchSetFocus(state.searchIndex + state.gridCols); return true; }
    return false;
  }

  /* ============================ picker ============================ */

  // A modal list over any screen: Up/Down move, OK picks, Back closes.
  function openPicker(title, options, selected, onPick) {
    var list = $('picker-list');
    list.innerHTML = '';
    list.scrollTop = 0;
    var rows = options.map(function (label, i) {
      var row = el('div', 'picker-row' + (i === selected ? ' selected' : ''), label);
      list.appendChild(row);
      return row;
    });
    $('picker-title').textContent = title;
    $('picker').classList.remove('hidden');
    state.picker = { rows: rows, index: 0, onPick: onPick };
    pickerFocus(Math.max(0, selected));
  }

  function pickerFocus(i) {
    var p = state.picker;
    p.index = Math.max(0, Math.min(p.rows.length - 1, i));
    p.rows.forEach(function (r, k) { r.classList.toggle('focused', k === p.index); });
    ensureVisible($('picker-list'), p.rows[p.index]);
  }

  function closePicker() {
    if (!state.picker) return;
    state.picker = null;
    $('picker').classList.add('hidden');
  }

  function pickerKey(code) {
    var p = state.picker;
    if (code === 38) pickerFocus(p.index - 1);
    if (code === 40) pickerFocus(p.index + 1);
    if (code === 13) {
      var pick = p.index;
      closePicker();
      p.onPick(pick);
    }
  }

  /* ============================ back ============================ */

  function handleBack() {
    switch (state.screen) {
      case 'player':
        cancelPendingNext();
        stopPlayback('detail');
        refreshSeries();
        return;
      case 'detail':
        state.detailSeq++;
        if (state.detailFrom === 'grid') {
          show('grid');
          gridSetFocus(state.gridIndex);
        } else if (state.detailFrom === 'search') {
          show('search');
          if (state.searchCards.length) searchSetFocus(state.searchIndex);
          else focusSearchInput();
        } else {
          show(state.rows.length ? 'home' : 'connect');
          if (state.rows.length) rowSetFocus(state.rowIndex, state.colIndex);
        }
        return;
      case 'grid':
        show('home');
        if (state.rows.length) rowSetFocus(state.rowIndex, state.colIndex);
        return;
      case 'search':
        state.searchSeq++;
        $('search-input').blur();
        show('home');
        if (state.rows.length) rowSetFocus(state.rowIndex, state.colIndex);
        return;
      case 'settings':
        // Rebuild the home screen so changed settings take effect immediately
        enterHome();
        return;
      case 'home':
        exitApp();
        return;
      case 'connect':
        if (state.addingProfile) {
          var back = state.addingProfile;
          state.addingProfile = null;
          error('');
          useProfile(back);
          return;
        }
        exitApp();
        return;
      default:
        exitApp();
    }
  }

  /* ============================ keyboard ============================ */

  document.addEventListener('keydown', function (ev) {
    var code = ev.keyCode || ev.which;

    if (state.picker) {
      ev.preventDefault();
      if (code === 461 || code === 27 || code === 8) closePicker();
      else pickerKey(code);
      return;
    }

    if (code === 461 || code === 27 || code === 8) {
      var typing = document.activeElement && document.activeElement.tagName === 'INPUT';
      if (typing && code === 8) return;
      if (typing) {
        document.activeElement.blur();
        if (state.screen === 'connect') {
          ev.preventDefault();
          connectSetFocus(state.connectFocus);
          return;
        }
        if (state.screen === 'search' && state.searchCards.length) {
          ev.preventDefault();
          searchSetFocus(state.searchIndex);
          return;
        }
      }
      ev.preventDefault();
      stopQuickConnect();
      handleBack();
      return;
    }

    if (state.screen === 'player') wakeOverlay();

    var handled = false;
    switch (state.screen) {
      case 'connect': handled = connectKey(code); break;
      case 'home': handled = homeKey(code); break;
      case 'grid': handled = gridKey(code); break;
      case 'search': handled = searchKey(code); break;
      case 'settings': handled = settingsKey(code); break;
      case 'detail': handled = detailKey(code); break;
      case 'player': handled = playerKey(code); break;
    }
    if (handled) ev.preventDefault();
  });

  /* ============================ wiring ============================ */

  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
    t.addEventListener('click', function () { switchTab(t.dataset.tab); });
  });

  $('qc-start').addEventListener('click', function () { startQuickConnect(); });
  $('pass-signin').addEventListener('click', function () { signInWithPassword(); });
  $('detail-play').addEventListener('click', function () {
    if (state.detailPlayTarget) playItem(state.detailPlayTarget);
  });
  $('detail-watched').addEventListener('click', function () { toggleWatched(); });
  $('detail-fav').addEventListener('click', function () { toggleFavorite(); });
  $('detail-version').addEventListener('click', function () { cycleVersion(); });

  // Player transport controls
  $('pc-prev').addEventListener('click', function () { skipBy(-1); });
  $('pc-play').addEventListener('click', function () { togglePlay(); });
  $('pc-next').addEventListener('click', function () { skipBy(1); });
  $('pc-subs').addEventListener('click', function () { chooseSubtitle(); });
  $('pc-audio').addEventListener('click', function () { chooseAudio(); });
  $('pc-stop').addEventListener('click', function () { stopPlayback('detail'); });

  // Keep focus model in sync when the user clicks with the pointer remote
  document.addEventListener('mousedown', function (e) {
    var t = e.target;
    if (state.screen === 'home' && t.classList && t.classList.contains('card')) {
      var row = state.rows.find(function (r) { return r.cards.indexOf(t) !== -1; });
      if (row) {
        state.rowIndex = state.rows.indexOf(row);
        rowSetFocus(state.rowIndex, row.cards.indexOf(t));
      }
    }
  });

  /* ============================ lifecycle ============================ */

  // The Home button backgrounds the app rather than closing it: pause and save
  // the position, so nothing is lost if the TV then kills the app.
  document.addEventListener('visibilitychange', function () {
    var s = state.player;
    if (!document.hidden || !s) return;
    var v = $('video');
    v.pause();
    api.reportProgress({
      ItemId: s.item.Id,
      MediaSourceId: s.source && s.source.Id,
      PlaySessionId: s.playSessionId,
      CanSeek: true,
      IsPaused: true,
      PositionTicks: api.toTicks(v.currentTime || 0),
      PlayMethod: 'DirectPlay'
    });
  });

  var sessionExpired = false;
  var booting = true;
  api.onUnauthorized = function () {
    if (booting || sessionExpired || !api.token) return;
    sessionExpired = true;
    forgetProfile(api.userId);
    cancelPendingNext();
    stopPlayback(null);
    api.signOut();
    state.rows = [];
    show('connect');
    connectSetFocus(0);
    error('Your session has expired. Please sign in again.');
  };

  /* ============================ diagnostics ============================ */
  // Exposed for the DevTools smoke test (see HANDOFF.md). Function
  // declarations are hoisted, so these references resolve.
  window.__silo = {
    api: api,
    state: state,
    settings: settings,
    show: show,
    enterHome: enterHome,
    openSearch: openSearch,
    openSettings: openSettings,
    runSearch: runSearch,
    openDetail: openDetail,
    openGrid: openGrid,
    settingsKey: settingsKey,
    searchKey: searchKey
  };

  /* ============================ boot ============================ */

  (async function boot() {
    loadSettings();
    applySubtitleStyle();
    // A session seeded into js/seed.js is applied once per token, so a new
    // seed still wins but a profile switched to afterwards survives restarts.
    var seed = window.SILO_SEED;
    var signedOut = false, seedSeen = '';
    try {
      signedOut = !!localStorage.getItem('silo.signedOut');
      seedSeen = localStorage.getItem('silo.seedApplied') || '';
    } catch (e) { /* ignore */ }
    if (seed && seed.server && seed.token && !signedOut && seedSeen !== seed.token) {
      api.setServer(seed.server);
      api.token = seed.token;
      api.userId = seed.userId || '';
      api.userName = seed.userName || '';
      api.persist();
      try { localStorage.setItem('silo.seedApplied', seed.token); } catch (e) { /* ignore */ }
    }

    var savedServer = '';
    try { savedServer = localStorage.getItem('silo.server') || ''; } catch (e) { /* ignore */ }
    $('server-url').value = savedServer || window.SILO_DEFAULT_SERVER || '';

    // Validate the saved session, then any other saved profile, before
    // falling back to sign-in.
    var candidates = api.load() ? [currentProfile()] : [];
    loadProfiles().forEach(function (p) {
      if (!candidates.some(function (c) { return c.userId === p.userId; })) candidates.push(p);
    });
    var unreachable = false;
    for (var i = 0; i < candidates.length; i++) {
      var p = candidates[i];
      api.setServer(p.server);
      api.token = p.token;
      api.userId = p.userId;
      api.userName = p.userName;
      for (var attempt = 0; attempt < 3; attempt++) {
        try {
          await api.views();
          api.persist();
          booting = false;
          enterHome();
          return;
        } catch (e) {
          if (e.status === 401) { forgetProfile(p.userId); break; }
          unreachable = true;
          await new Promise(function (r) { setTimeout(r, 3000); });
        }
      }
      if (unreachable) break;
    }
    booting = false;
    if (unreachable) {
      show('connect');
      connectSetFocus(0);
      error('Could not reach the server. Your sign-in is kept; reopen the app to retry.');
      return;
    }
    api.signOut();
    show('connect');
    connectSetFocus(0);
  })();
})();
