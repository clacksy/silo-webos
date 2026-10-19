/*
 * Silo webOS client — API layer.
 *
 * Silo exposes a Jellyfin-compatible API at a separate address from its web UI
 * (Silo docs: /docs/jellyfin-apps). This module speaks that API: sign-in,
 * Quick Connect, libraries, items, images, playback and progress reporting.
 */
(function (global) {
  'use strict';

  var CLIENT = 'Silo webOS';
  var DEVICE = 'LG webOS TV';
  var VERSION = '0.5.0';
  var TICKS = 10000000; // .NET ticks per second

  var LS = {
    server: 'silo.server',
    token: 'silo.token',
    userId: 'silo.userId',
    userName: 'silo.userName',
    deviceId: 'silo.deviceId'
  };

  function getDeviceId() {
    var id = null;
    try { id = localStorage.getItem(LS.deviceId); } catch (e) { /* storage blocked */ }
    if (!id) {
      id = 'silo-webos-' + Math.random().toString(36).slice(2, 10);
      try { localStorage.setItem(LS.deviceId, id); } catch (e) { /* ignore */ }
    }
    return id;
  }

  function normalizeBase(url) {
    var u = (url || '').trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
    return u.replace(/\/+$/, '');
  }

  function qs(params) {
    var out = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null || v === '') return;
      out.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    return out.join('&');
  }

  function Api() {
    this.base = '';
    this.token = '';
    this.userId = '';
    this.userName = '';
    this.deviceId = getDeviceId();
  }

  Api.prototype.load = function () {
    try {
      this.base = localStorage.getItem(LS.server) || '';
      this.token = localStorage.getItem(LS.token) || '';
      this.userId = localStorage.getItem(LS.userId) || '';
      this.userName = localStorage.getItem(LS.userName) || '';
    } catch (e) { /* ignore */ }
    return !!this.token;
  };

  Api.prototype.persist = function () {
    try {
      localStorage.setItem(LS.server, this.base);
      localStorage.setItem(LS.token, this.token);
      localStorage.setItem(LS.userId, this.userId);
      localStorage.setItem(LS.userName, this.userName);
    } catch (e) { /* ignore */ }
  };

  Api.prototype.signOut = function () {
    this.token = '';
    this.userId = '';
    this.userName = '';
    try {
      localStorage.removeItem(LS.token);
      localStorage.removeItem(LS.userId);
      localStorage.removeItem(LS.userName);
    } catch (e) { /* ignore */ }
  };

  Api.prototype.setServer = function (url) {
    this.base = normalizeBase(url);
    return this.base;
  };

  Api.prototype.headers = function (extra) {
    var auth = [
      'Client="' + CLIENT + '"',
      'Device="' + DEVICE + '"',
      'DeviceId="' + this.deviceId + '"',
      'Version="' + VERSION + '"'
    ];
    if (this.token) auth.push('Token="' + this.token + '"');

    var h = {
      Accept: 'application/json',
      'X-Emby-Authorization': 'MediaBrowser ' + auth.join(', '),
      'X-Emby-Client': CLIENT,
      'X-Emby-Device-Name': DEVICE,
      'X-Emby-Device-Id': this.deviceId,
      'X-Emby-Client-Version': VERSION
    };
    if (this.token) h['X-Emby-Token'] = this.token;
    if (extra) {
      Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
    }
    return h;
  };

  Api.prototype.request = function (path, opts) {
    opts = opts || {};
    var self = this;
    if (!this.base) return Promise.reject(new Error('No server address set'));

    var url = this.base + path;
    var query = qs(opts.query);
    if (query) url += (url.indexOf('?') === -1 ? '?' : '&') + query;

    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, opts.timeout || 20000) : null;

    var init = {
      method: opts.method || 'GET',
      headers: this.headers(opts.body ? { 'Content-Type': 'application/json' } : null)
    };
    if (opts.body) init.body = JSON.stringify(opts.body);
    if (controller) init.signal = controller.signal;

    return fetch(url, init).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) {
        return res.text().then(function (text) {
          var msg = '';
          try { var j = JSON.parse(text); msg = j.message || j.error || j.title || ''; } catch (e) { /* not json */ }
          if (!msg) msg = text ? text.slice(0, 180) : (res.status + ' ' + res.statusText);
          var err = new Error(msg);
          err.status = res.status;
          throw err;
        });
      }
      if (res.status === 204) return null;
      var ct = res.headers.get('content-type') || '';
      return ct.indexOf('application/json') !== -1 ? res.json() : res.text();
    }).catch(function (e) {
      if (timer) clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new Error('Server timed out');
      if (e && e.status) throw e;
      throw new Error('Could not reach the server');
    });
  };

  /* ---------------- sign-in ---------------- */

  Api.prototype.signInWithPassword = function (username, password) {
    var self = this;
    return this.request('/Users/AuthenticateByName', {
      method: 'POST',
      body: { Username: username, Pw: password }
    }).then(function (data) { return self._applySession(data); });
  };

  Api.prototype.quickConnectEnabled = function () {
    return this.request('/QuickConnect/Enabled').then(function (r) {
      return r === true || r === 'true';
    }).catch(function () { return false; });
  };

  Api.prototype.quickConnectStart = function () {
    return this.request('/QuickConnect/Initiate', { method: 'POST', body: {} });
  };

  Api.prototype.quickConnectPoll = function (secret) {
    return this.request('/QuickConnect/Connect', { query: { secret: secret } });
  };

  Api.prototype.quickConnectFinish = function (secret) {
    var self = this;
    return this.request('/Users/AuthenticateWithQuickConnect', {
      method: 'POST',
      body: { Secret: secret }
    }).then(function (data) { return self._applySession(data); });
  };

  Api.prototype._applySession = function (data) {
    var session = data || {};
    var user = session.User || (session.SessionInfo && session.SessionInfo.User) || {};
    this.token = session.AccessToken || (session.SessionInfo && session.SessionInfo.AccessToken) || '';
    this.userId = user.Id || '';
    this.userName = user.Name || '';
    if (!this.token) throw new Error('Sign-in succeeded but no access token was returned');
    this.persist();
    return session;
  };

  Api.prototype.publicInfo = function () {
    return this.request('/System/Info/Public');
  };

  /* ---------------- content ---------------- */

  Api.prototype.views = function () {
    return this.request('/Users/' + this.userId + '/Views').then(function (r) {
      return (r && r.Items) || [];
    });
  };

  Api.prototype.items = function (params) {
    return this.request('/Users/' + this.userId + '/Items', { query: params }).then(function (r) {
      return (r && r.Items) || [];
    });
  };

  Api.prototype.libraryItems = function (parentId, start, limit) {
    return this.items({
      ParentId: parentId,
      IncludeItemTypes: 'Movie,Series',
      Recursive: true,
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      ImageTypeLimit: 1,
      EnableImageTypes: 'Primary',
      Fields: 'ProductionYear,RunTimeTicks,PrimaryImageAspectRatio',
      StartIndex: start || 0,
      Limit: limit || 120
    });
  };

  Api.prototype.resumeItems = function (limit) {
    return this.request('/Users/' + this.userId + '/Items/Resume', {
      query: {
        Limit: limit || 14,
        MediaTypes: 'Video',
        ImageTypeLimit: 1,
        EnableImageTypes: 'Primary',
        Fields: 'ProductionYear,RunTimeTicks'
      }
    }).then(function (r) { return (r && r.Items) || []; });
  };

  Api.prototype.latestItems = function (parentId, limit) {
    return this.request('/Users/' + this.userId + '/Items/Latest', {
      query: {
        ParentId: parentId,
        Limit: limit || 16,
        ImageTypeLimit: 1,
        EnableImageTypes: 'Primary',
        Fields: 'ProductionYear,RunTimeTicks'
      }
    }).then(function (r) { return Array.isArray(r) ? r : ((r && r.Items) || []); });
  };

  Api.prototype.item = function (itemId) {
    return this.request('/Users/' + this.userId + '/Items/' + itemId);
  };

  Api.prototype.episodes = function (seriesId) {
    return this.request('/Shows/' + seriesId + '/Episodes', {
      query: {
        UserId: this.userId,
        ImageTypeLimit: 1,
        EnableImageTypes: 'Primary',
        Fields: 'Overview,RunTimeTicks'
      }
    }).then(function (r) { return (r && r.Items) || []; });
  };

  Api.prototype.playbackInfo = function (itemId) {
    return this.request('/Items/' + itemId + '/PlaybackInfo', {
      method: 'POST',
      query: { UserId: this.userId },
      body: { UserId: this.userId }
    });
  };

  Api.prototype.search = function (term, limit) {
    return this.items({
      searchTerm: term,
      IncludeItemTypes: 'Movie,Series',
      Recursive: true,
      Limit: limit || 60,
      ImageTypeLimit: 1,
      EnableImageTypes: 'Primary',
      Fields: 'ProductionYear,RunTimeTicks,SeriesName,SeasonName'
    });
  };

  Api.prototype.libraryPage = function (parentId, start, limit) {
    return this.request('/Users/' + this.userId + '/Items', {
      query: {
        ParentId: parentId,
        IncludeItemTypes: 'Movie,Series',
        Recursive: true,
        SortBy: 'SortName',
        SortOrder: 'Ascending',
        ImageTypeLimit: 1,
        EnableImageTypes: 'Primary',
        Fields: 'ProductionYear,RunTimeTicks,PrimaryImageAspectRatio',
        StartIndex: start || 0,
        Limit: limit || 120
      }
    }).then(function (r) {
      return r || { Items: [], TotalRecordCount: 0 };
    });
  };

  /* ---------------- user state ---------------- */

  Api.prototype.markPlayed = function (itemId, played) {
    return this.request('/Users/' + this.userId + '/PlayedItems/' + itemId, {
      method: played ? 'POST' : 'DELETE',
      body: played ? {} : undefined
    });
  };

  Api.prototype.setFavorite = function (itemId, favorite) {
    return this.request('/Users/' + this.userId + '/FavoriteItems/' + itemId, {
      method: favorite ? 'POST' : 'DELETE',
      body: favorite ? {} : undefined
    });
  };

  /* ---------------- images ---------------- */

  Api.prototype.imageUrl = function (itemId, type, maxHeight) {
    return this.base + '/Items/' + itemId + '/Images/' + (type || 'Primary') +
      '?maxHeight=' + (maxHeight || 420) + '&quality=90&api_key=' + encodeURIComponent(this.token);
  };

  // Silo extracts embedded subtitles to WebVTT on demand, which can take tens
  // of seconds, so this needs its own generous timeout and an abort path.
  Api.prototype.subtitleText = function (itemId, mediaSourceId, index, timeoutMs) {
    var url = this.subtitleUrl(itemId, mediaSourceId, index);
    var headers = this.headers();
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var limit = timeoutMs || 120000;
    var timer = controller ? setTimeout(function () { controller.abort(); }, limit) : null;

    return fetch(url, { headers: headers, signal: controller ? controller.signal : undefined })
      .then(function (r) {
        if (timer) clearTimeout(timer);
        if (!r.ok) throw new Error('Subtitle request failed (' + r.status + ')');
        return r.text();
      }, function (e) {
        if (timer) clearTimeout(timer);
        if (e && e.name === 'AbortError') throw new Error('timed out after ' + Math.round(limit / 1000) + 's');
        throw new Error('could not reach the server');
      });
  };

  Api.prototype.subtitleUrl = function (itemId, mediaSourceId, index) {
    return this.base + '/Videos/' + itemId + '/' + encodeURIComponent(mediaSourceId) +
      '/Subtitles/' + index + '/Stream.vtt?api_key=' + encodeURIComponent(this.token);
  };

  Api.prototype.backdropUrl = function (itemId) {
    return this.base + '/Items/' + itemId + '/Images/Backdrop' +
      '?maxWidth=1920&quality=85&api_key=' + encodeURIComponent(this.token);
  };

  /* ---------------- playback ---------------- */

  Api.prototype.directStreamUrl = function (itemId, mediaSource) {
    var ms = mediaSource && mediaSource.Id ? '&MediaSourceId=' + encodeURIComponent(mediaSource.Id) : '';
    return this.base + '/Videos/' + itemId + '/stream?static=true' + ms +
      '&api_key=' + encodeURIComponent(this.token);
  };

  Api.prototype.hlsStreamUrl = function (itemId, mediaSource) {
    var ms = mediaSource && mediaSource.Id ? 'MediaSourceId=' + encodeURIComponent(mediaSource.Id) + '&' : '';
    return this.base + '/Videos/' + itemId + '/master.m3u8?' + ms +
      'VideoCodec=h264&AudioCodec=aac&SegmentContainer=ts' +
      '&MaxWidth=1920&MaxHeight=1080&VideoBitrate=12000000&AudioBitrate=192000' +
      '&TranscodingMaxAudioChannels=2&RequireAvc=true' +
      '&api_key=' + encodeURIComponent(this.token);
  };

  Api.prototype.reportPlaying = function (payload) {
    return this.request('/Sessions/Playing', { method: 'POST', body: payload }).catch(function () {});
  };

  Api.prototype.reportProgress = function (payload) {
    return this.request('/Sessions/Playing/Progress', { method: 'POST', body: payload }).catch(function () {});
  };

  Api.prototype.reportStopped = function (payload) {
    return this.request('/Sessions/Playing/Stopped', { method: 'POST', body: payload }).catch(function () {});
  };

  Api.prototype.toTicks = function (seconds) {
    return Math.max(0, Math.floor(seconds * TICKS));
  };

  Api.ticksToSeconds = function (ticks) {
    return Math.max(0, (ticks || 0) / TICKS);
  };

  global.SiloApi = Api;
})(window);
