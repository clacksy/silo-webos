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
  var APP_VERSION = '0.5.0';

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
    detailFocus: 0, // 0 = play button, 1..n = episodes
    episodeCards: [],
    // search
    searchCards: [],
    searchIndex: 0,
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
  var settings = { showResume: true, latestRows: 4, seekStep: 10 };

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

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }

  /* ============================ helpers ============================ */

  function show(name) {
    state.screen = name;
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
    card.appendChild(el('div', 'card-label', item.Name || 'Untitled'));
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

    var views = [];
    try { views = await api.views(); } catch (e) { /* handled below */ }

    rowsEl.removeChild(status);

    if (!views.length && !api.token) { show('connect'); return; }

    // Server identity, used by the settings screen
    if (!state.serverInfo) {
      try { state.serverInfo = await api.publicInfo(); } catch (e) { /* optional */ }
    }

    // Continue watching (respects the setting)
    if (settings.showResume) {
      try {
        var resume = await api.resumeItems(14);
        if (resume.length) {
          state.rows.push(addRow('Continue watching', resume.map(function (i) {
            return makeCard(i, { wide: true });
          })));
        }
      } catch (e) { /* no resume row */ }
    }

    // Recent per library (how many is a setting)
    var maxRows = Number(settings.latestRows) || 4;
    for (var i = 0; i < views.length && i < maxRows; i++) {
      var v = views[i];
      try {
        var latest = await api.latestItems(v.Id, 16);
        if (latest.length) {
          state.rows.push(addRow('Recently added · ' + v.Name, latest.map(function (it) {
            return makeCard(it, {});
          })));
        }
      } catch (e) { /* skip this library */ }
    }

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

  async function homeKey(code) {
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

  async function openGrid(view) {
    show('grid');
    $('grid-title').textContent = view.Name || 'Library';
    $('grid').innerHTML = '';
    state.gridCards = [];
    state.gridIndex = 0;
    state.gridView = view;
    state.gridStart = 0;
    state.gridTotal = 0;
    await loadGridPage();
    if (state.gridCards.length) gridSetFocus(0);
  }

  async function loadGridPage() {
    if (!state.gridView) return;
    if (state.gridLoading) return;
    state.gridLoading = true;
    var page = { Items: [], TotalRecordCount: 0 };
    try {
      page = await api.libraryPage(state.gridView.Id, state.gridStart, 120);
    } catch (e) {
      state.gridLoading = false;
      return;
    }
    var items = page.Items || [];
    state.gridTotal = page.TotalRecordCount || 0;
    items.forEach(function (item) {
      var card = makeCard(item, {});
      card.classList.add('grid-card');
      $('grid').appendChild(card);
      state.gridCards.push(card);
    });
    state.gridStart += items.length;
    if (!state.gridCards.length) {
      $('grid').appendChild(el('p', 'hint', 'This library is empty.'));
    }
    state.gridLoading = false;
  }

  function gridSetFocus(i) {
    if (!state.gridCards.length) return;
    state.gridIndex = Math.max(0, Math.min(state.gridCards.length - 1, i));
    clearFocus();
    var card = state.gridCards[state.gridIndex];
    card.classList.add('focused');
    ensureVisible($('grid-wrap'), card);

    // Fetch the next page as the user approaches the end
    if (state.gridStart < state.gridTotal && state.gridIndex >= state.gridCards.length - 8) {
      loadGridPage();
    }
  }

  function gridKey(code) {
    var cols = state.gridCols;
    if (code === 37) { gridSetFocus(state.gridIndex - 1); return true; }
    if (code === 39) { gridSetFocus(state.gridIndex + 1); return true; }
    if (code === 38) { gridSetFocus(state.gridIndex - cols); return true; }
    if (code === 40) { gridSetFocus(state.gridIndex + cols); return true; }
    if (code === 13) {
      var card = state.gridCards[state.gridIndex];
      if (card && card.__item) openDetail(card.__item.Id);
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

  async function openDetail(id) {
    show('detail');
    $('detail-episodes').classList.add('hidden');
    $('episode-track').innerHTML = '';
    state.episodeCards = [];
    state.detailFocus = 0;
    state.detailSources = [];
    state.detailSourceIndex = 0;
    state.detailPlayback = null;
    $('detail-version').classList.add('hidden');

    var item = null;
    try { item = await api.item(id); } catch (e) { show('home'); return; }
    state.detailItem = item;

    var title = item.Name || '';
    if (item.Type === 'Episode' && item.SeriesName) {
      title = item.SeriesName + ' — ' + (item.Name || '');
    }
    $('detail-title').textContent = title;
    $('detail-poster').src = api.imageUrl(item.Id, 'Primary', 640);
    $('detail-poster').onerror = function () { this.style.visibility = 'hidden'; };
    $('detail-bg').style.backgroundImage = 'url("' + api.backdropUrl(item.Id) + '")';

    var bits = [];
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
      try {
        var eps = await api.episodes(item.Id);
        if (eps.length) {
          $('detail-episodes').classList.remove('hidden');
          eps.forEach(function (ep) {
            var card = el('div', 'card wide');
            var img = document.createElement('img');
            img.src = api.imageUrl(ep.Id, 'Primary', 300);
            img.onerror = function () { img.style.visibility = 'hidden'; };
            card.appendChild(img);
            var label = ep.Name || 'Episode';
            if (ep.IndexNumber) label = ep.IndexNumber + '. ' + label;
            card.appendChild(el('div', 'card-label', label));
            card.__item = ep;
            $('episode-track').appendChild(card);
            state.episodeCards.push(card);
          });
        }
      } catch (e) { /* no episodes */ }
    }

    detailSetFocus(0);
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

  function detailButtons() {
    return [$('detail-play'), $('detail-watched'), $('detail-fav'), $('detail-version')]
      .filter(function (b) { return b && b.offsetParent !== null; });
  }

  function detailSetFocus(i) {
    var buttons = detailButtons();
    var nb = buttons.length;
    var total = nb + state.episodeCards.length;
    state.detailFocus = Math.max(0, Math.min(total - 1, i));
    clearFocus();

    if (state.detailFocus < nb) {
      buttons[state.detailFocus].classList.add('focused');
      return;
    }

    var card = state.episodeCards[state.detailFocus - nb];
    card.classList.add('focused');
    var track = $('episode-track');
    var win = track.parentElement;
    var shift = Math.max(0, card.offsetLeft - 80);
    var maxShift = Math.max(0, track.scrollWidth - win.clientWidth + 40);
    track.style.transform = 'translateX(' + (-Math.min(shift, maxShift)) + 'px)';
  }

  function detailKey(code) {
    var nb = detailButtons().length;
    var nEp = state.episodeCards.length;
    var f = state.detailFocus;
    var inButtons = f < nb;

    if (code === 37) { detailSetFocus(inButtons ? Math.max(0, f - 1) : Math.max(nb, f - 1)); return true; }
    if (code === 39) { detailSetFocus(inButtons ? Math.min(nb - 1, f + 1) : Math.min(nb + nEp - 1, f + 1)); return true; }
    if (code === 38) {
      if (inButtons) return true;
      detailSetFocus(f === nb ? Math.floor(nb / 2) : f - 1);
      return true;
    }
    if (code === 40) {
      if (inButtons) { if (nEp) detailSetFocus(nb); return true; }
      if (f < nb + nEp - 1) detailSetFocus(f + 1);
      return true;
    }
    if (code === 13) {
      if (inButtons) {
        var btn = detailButtons()[f];
        if (btn) btn.click();
      } else {
        var card = state.episodeCards[f - nb];
        if (card && card.__item) playItem(card.__item);
      }
      return true;
    }
    return false;
  }

  /* ============================ player ============================ */

  function playerStatus(msg) {
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
    if (bar) bar.style.width = (dur ? Math.min(100, (v.currentTime / dur) * 100) : 0) + '%';
    if (time) {
      var res = v.videoWidth ? ('  ·  ' + v.videoWidth + '\u00d7' + v.videoHeight) : '';
      time.textContent = fmtTime(v.currentTime) + '  /  ' + fmtTime(dur) + res;
    }
    if (playBtn) playBtn.textContent = v.paused ? 'Play' : 'Pause';
  }

  function playerControlList() {
    return [$('pc-prev'), $('pc-play'), $('pc-next'), $('pc-subs'), $('pc-stop')].filter(Boolean);
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

  function skipBy(dir) {
    var v = $('video');
    var step = Number(settings.seekStep) || 10;
    var dur = v.duration || 0;
    v.currentTime = Math.max(0, Math.min(dur ? dur - 1 : 1e9, v.currentTime + dir * step));
    playerStatus((dir > 0 ? '+' : '-') + step + 's');
    playerTick();
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
  }

  // Text tracks are fetched with an opaque response unless the element is
  // CORS-enabled, which silently yields zero cues. Fetching the WebVTT here and
  // serving it as a blob URL makes it same-origin, so it always loads.
  function subtitleTextFor(session, stream) {
    var key = String(stream.Index);
    if (session.subCache[key] !== undefined) return Promise.resolve(session.subCache[key]);
    if (session.subPending[key]) return session.subPending[key];

    var promise = api.subtitleText(session.item.Id, session.source.Id, stream.Index)
      .then(function (text) {
        session.subCache[key] = text;
        delete session.subPending[key];
        return text;
      }, function (err) {
        delete session.subPending[key];
        throw err;
      });
    session.subPending[key] = promise;
    return promise;
  }

  // Warm the cache in the background so turning subtitles on is instant when
  // the server takes a minute to extract them.
  async function prefetchSubtitles(session) {
    var ordered = session.subs.slice().sort(function (a, b) {
      return (b.IsDefault ? 1 : 0) - (a.IsDefault ? 1 : 0);
    }).slice(0, 3);
    for (var i = 0; i < ordered.length; i++) {
      if (state.player !== session) return;
      try { await subtitleTextFor(session, ordered[i]); } catch (e) { /* retried on demand */ }
    }
  }

  async function showSubtitle(index) {
    var s = state.player;
    if (!s) return;
    clearSubtitleTracks();
    if (index < 0) {
      playerStatus('Subtitles off');
      return;
    }
    var stream = s.subs[index];
    if (!stream || !s.source || !s.source.Id) {
      playerStatus('This file has no downloadable subtitles');
      return;
    }

    var key = String(stream.Index);
    var text = s.subCache[key];
    if (text === undefined) {
      var started = Date.now();
      playerStatus('Loading subtitles…');
      var ticker = setInterval(function () {
        var secs = Math.round((Date.now() - started) / 1000);
        playerStatus('Loading subtitles… ' + secs + 's (server is extracting them)');
      }, 1000);

      try {
        text = await subtitleTextFor(s, stream);
      } catch (e) {
        clearInterval(ticker);
        playerStatus('Subtitles unavailable: ' + (e.message || 'error'));
        return;
      }
      clearInterval(ticker);
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

  function cycleSubtitle() {
    var s = state.player;
    if (!s) return;
    if (!s.subs || !s.subs.length) {
      playerStatus('No subtitle tracks in this file');
      return;
    }
    s.subIndex += 1;
    if (s.subIndex >= s.subs.length) s.subIndex = -1;
    showSubtitle(s.subIndex);
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
    }
    if (!source) source = pickBestSource((info && info.MediaSources) || []);
    var streams = (source && source.MediaStreams) || [];
    var subs = streams.filter(function (s) { return s.Type === 'Subtitle'; });
    var audio = streams.filter(function (s) { return s.Type === 'Audio'; });

    var session = {
      item: item,
      source: source,
      subs: subs,
      audio: audio,
      subIndex: -1,
      subCache: {},
      subPending: {},
      playSessionId: (info && info.PlaySessionId) || '',
      reported: false,
      timer: null,
      ticker: null,
      hlsTried: false
    };
    state.player = session;
    state.playerFocus = 0;

    clearSubtitleTracks();
    var subsBtn = $('pc-subs');
    if (subsBtn) subsBtn.textContent = subtitleLabel();

    if (audio.length > 1) {
      playerStatus('Audio: ' + (audio[0].DisplayTitle || audio[0].Language || 'track 1'));
    }

    var startSeconds = 0;
    if (item.UserData && item.UserData.PlaybackPositionTicks) {
      startSeconds = window.SiloApi.ticksToSeconds(item.UserData.PlaybackPositionTicks);
    } else if (info && info.StartTimeTicks) {
      startSeconds = window.SiloApi.ticksToSeconds(info.StartTimeTicks);
    }

    function begin(url) {
      video.src = url;
      video.load();
      var onMeta = function () {
        video.removeEventListener('loadedmetadata', onMeta);
        if (startSeconds > 2 && startSeconds < video.duration - 5) {
          video.currentTime = startSeconds;
        }
        var p = video.play();
        if (p && p.catch) p.catch(function () { playerStatus('Press OK to start playback'); });
        // Report the decoded resolution in the title so it can be read over SSH
        try {
          document.title = 'Silo \u00b7 player \u00b7 ' +
            (video.videoWidth || 0) + 'x' + (video.videoHeight || 0);
        } catch (e) { /* ignore */ }
        playerTick();
      };
      video.addEventListener('loadedmetadata', onMeta);
    }

    video.onerror = function () {
      if (!session.hlsTried) {
        session.hlsTried = true;
        playerStatus('Direct play unsupported — transcoding…');
        begin(api.hlsStreamUrl(item.Id, source));
        return;
      }
      playerStatus('Playback failed. Press Back to return.');
    };

    video.onplaying = function () {
      playerStatus('');
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
          PlayMethod: 'DirectPlay'
        });
      }, 10000);
      clearInterval(session.ticker);
      session.ticker = setInterval(playerTick, 500);
      if (!session.prefetched) {
        session.prefetched = true;
        setTimeout(function () { prefetchSubtitles(session); }, 2500);
      }
    };

    video.ontimeupdate = playerTick;
    video.onpause = playerTick;

    begin(api.directStreamUrl(item.Id, source));
  }

  function stopPlayback(returnTo) {
    var s = state.player;
    var video = $('video');
    if (s) {
      if (s.timer) clearInterval(s.timer);
      if (s.ticker) clearInterval(s.ticker);
      api.reportStopped({
        ItemId: s.item.Id,
        MediaSourceId: s.source && s.source.Id,
        PlaySessionId: s.playSessionId,
        PositionTicks: api.toTicks(video.currentTime || 0)
      });
      state.player = null;
    }
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (returnTo) show(returnTo);
  }

  function playerKey(code) {
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

    if (code === 13 || code === 415 || code === 19) { togglePlay(); return true; }
    if (code === 39 || code === 417) { skipBy(1); return true; }
    if (code === 37 || code === 412) { skipBy(-1); return true; }
    return false;
  }

  /* ============================ back ============================ */

  function handleBack() {
    switch (state.screen) {
      case 'player':
        stopPlayback('detail');
        return;
      case 'detail':
        show(state.rows.length ? 'home' : 'connect');
        if (state.rows.length) rowSetFocus(state.rowIndex, state.colIndex);
        return;
      case 'grid':
        show('home');
        if (state.rows.length) rowSetFocus(state.rowIndex, state.colIndex);
        return;
      case 'search':
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
      default:
        exitApp();
    }
  }

  /* ============================ keyboard ============================ */

  document.addEventListener('keydown', function (ev) {
    var code = ev.keyCode || ev.which;

    if (code === 461 || code === 27 || code === 8) {
      ev.preventDefault();
      stopQuickConnect();
      handleBack();
      return;
    }

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
    if (state.detailItem) playItem(state.detailItem);
  });
  $('detail-watched').addEventListener('click', function () { toggleWatched(); });
  $('detail-fav').addEventListener('click', function () { toggleFavorite(); });
  $('detail-version').addEventListener('click', function () { cycleVersion(); });

  // Player transport controls
  $('pc-prev').addEventListener('click', function () { skipBy(-1); });
  $('pc-play').addEventListener('click', function () { togglePlay(); });
  $('pc-next').addEventListener('click', function () { skipBy(1); });
  $('pc-subs').addEventListener('click', function () { cycleSubtitle(); });
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

  /* ============================ boot ============================ */

  (async function boot() {
    // A session seeded into js/seed.js wins: no sign-in on the TV needed.
    var seed = window.SILO_SEED;
    var signedOut = false;
    try { signedOut = !!localStorage.getItem('silo.signedOut'); } catch (e) { /* ignore */ }
    if (seed && seed.server && seed.token && !signedOut) {
      api.setServer(seed.server);
      api.token = seed.token;
      api.userId = seed.userId || '';
      api.userName = seed.userName || '';
      api.persist();
    }

    var savedServer = '';
    try { savedServer = localStorage.getItem('silo.server') || ''; } catch (e) { /* ignore */ }
    $('server-url').value = savedServer || window.SILO_DEFAULT_SERVER || '';

    if (api.load()) {
      // Validate the saved session before skipping sign-in
      try {
        await api.views();
        enterHome();
        return;
      } catch (e) {
        api.signOut();
      }
    }
    show('connect');
    connectSetFocus(0);
  })();
})();
