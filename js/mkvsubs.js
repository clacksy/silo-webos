/*
 * Silo webOS client — subtitles read straight from the MKV file.
 *
 * Silo can only serve an embedded subtitle after extracting it from the whole
 * file, which takes minutes for a remux and makes the server read every byte.
 * Most MKVs index each subtitle line in their Cues element, so the lines can
 * be read with tiny range requests instead: the index once (~100 KB), then a
 * few hundred bytes per line, fetched just ahead of the playback position and
 * never more than two at a time.
 */
(function (global) {
  'use strict';

  var ID = {
    EBML: 0x1A45DFA3, SEGMENT: 0x18538067,
    SEEKHEAD: 0x114D9B74, SEEK: 0x4DBB, SEEK_ID: 0x53AB, SEEK_POS: 0x53AC,
    INFO: 0x1549A966, SCALE: 0x2AD7B1,
    TRACKS: 0x1654AE6B, ENTRY: 0xAE, NUMBER: 0xD7, TYPE: 0x83, CODEC: 0x86,
    CUES: 0x1C53BB6B, POINT: 0xBB, TIME: 0xB3, POSITIONS: 0xB7, TRACK: 0xF7,
    CLUSTER_POS: 0xF1, REL_POS: 0xF0, DURATION: 0xB2,
    GROUP: 0xA0, BLOCK: 0xA1, BLOCK_DURATION: 0x9B, SIMPLE: 0xA3
  };
  var SUBTITLE = 0x11;
  var TEXT_CODECS = /^S_TEXT\/(UTF8|ASS|SSA|WEBVTT)$/;
  var LOOKAHEAD = 60;
  var PARALLEL = 2;
  var MAX_INDEX = 8 * 1024 * 1024;

  /* ---------------- byte access ---------------- */

  // Never let a server that ignores Range stream a whole 20 GB file at us.
  // Waits out the API's shared 429 cooldown, and starts one on a 429.
  function range(url, start, length) {
    var Api = global.SiloApi;
    return (Api && Api.cooldown ? Api.cooldown() : Promise.resolve()).then(function () {
      return rangeNow(url, start, length);
    });
  }

  function rangeNow(url, start, length) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 20000);
    return fetch(url, {
      headers: { Range: 'bytes=' + start + '-' + (start + length - 1) },
      signal: controller.signal
    }).then(function (res) {
      if (res.status === 429) {
        controller.abort();
        if (global.SiloApi && global.SiloApi.backOff) global.SiloApi.backOff(res.headers.get('Retry-After'));
        var busy = new Error('rate limited');
        busy.status = 429;
        throw busy;
      }
      if (res.status !== 206) {
        controller.abort();
        throw new Error('range request refused (' + res.status + ')');
      }
      return res.arrayBuffer();
    }).then(function (buf) {
      clearTimeout(timer);
      return new Uint8Array(buf);
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  function vint(b, i, keepMarker) {
    if (i >= b.length) return null;
    var first = b[i];
    var len = 1;
    var mask = 0x80;
    while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
    if (len > 8 || i + len > b.length) return null;
    var value = keepMarker ? first : (first & (mask - 1));
    for (var k = 1; k < len; k++) value = value * 256 + b[i + k];
    return { value: value, next: i + len };
  }

  function header(b, i) {
    var id = vint(b, i, true);
    if (!id) return null;
    var size = vint(b, id.next, false);
    if (!size) return null;
    return { id: id.value, start: size.next, size: size.value, end: size.next + size.value };
  }

  function each(b, start, end, fn) {
    var i = start;
    while (i < end) {
      var h = header(b, i);
      if (!h || h.end > b.length) return;
      fn(h);
      i = h.end;
    }
  }

  function uint(b, start, end) {
    var v = 0;
    for (var i = start; i < end; i++) v = v * 256 + b[i];
    return v;
  }

  function fetchElement(url, offset, guess) {
    return range(url, offset, guess).then(function (b) {
      var h = header(b, 0);
      if (!h) throw new Error('bad element at ' + offset);
      if (h.end <= b.length) return { bytes: b, el: h };
      if (h.end > MAX_INDEX) throw new Error('element too large');
      return range(url, offset, h.end).then(function (all) {
        return { bytes: all, el: header(all, 0) };
      });
    });
  }

  /* ---------------- file index ---------------- */

  function open(url) {
    return range(url, 0, 65536).then(function (head) {
      var ebml = header(head, 0);
      if (!ebml || ebml.id !== ID.EBML) throw new Error('not a Matroska file');
      var seg = header(head, ebml.end);
      if (!seg || seg.id !== ID.SEGMENT) throw new Error('no segment');
      var base = seg.start;
      var pos = {};
      each(head, base, head.length, function (h) {
        if (h.id !== ID.SEEKHEAD || Object.keys(pos).length) return;
        each(head, h.start, h.end, function (seek) {
          if (seek.id !== ID.SEEK) return;
          var sid = null, spos = null;
          each(head, seek.start, seek.end, function (f) {
            if (f.id === ID.SEEK_ID) sid = uint(head, f.start, f.end);
            if (f.id === ID.SEEK_POS) spos = uint(head, f.start, f.end);
          });
          if (sid !== null && spos !== null) pos[sid] = spos;
        });
      });
      if (pos[ID.TRACKS] === undefined || pos[ID.CUES] === undefined) throw new Error('no index');

      var file = { url: url, base: base, scale: 1000000, tracks: [], cues: {}, clusterHeader: null };
      var info = pos[ID.INFO] === undefined ? Promise.resolve(null) : fetchElement(url, base + pos[ID.INFO], 4096);
      return info.then(function (r) {
        if (r) {
          each(r.bytes, r.el.start, r.el.end, function (f) {
            if (f.id === ID.SCALE) file.scale = uint(r.bytes, f.start, f.end);
          });
        }
        return fetchElement(url, base + pos[ID.TRACKS], 65536);
      }).then(function (r) {
        var b = r.bytes;
        each(b, r.el.start, r.el.end, function (entry) {
          if (entry.id !== ID.ENTRY) return;
          var t = { number: 0, type: 0, codec: '' };
          each(b, entry.start, entry.end, function (f) {
            if (f.id === ID.NUMBER) t.number = uint(b, f.start, f.end);
            if (f.id === ID.TYPE) t.type = uint(b, f.start, f.end);
            if (f.id === ID.CODEC) t.codec = String.fromCharCode.apply(null, b.subarray(f.start, f.end));
          });
          file.tracks.push(t);
        });
        return fetchElement(url, base + pos[ID.CUES], 65536);
      }).then(function (r) {
        var b = r.bytes;
        var wanted = {};
        file.tracks.forEach(function (t) { if (t.type === SUBTITLE) wanted[t.number] = true; });
        each(b, r.el.start, r.el.end, function (point) {
          if (point.id !== ID.POINT) return;
          var time = 0;
          each(b, point.start, point.end, function (f) {
            if (f.id === ID.TIME) { time = uint(b, f.start, f.end); return; }
            if (f.id !== ID.POSITIONS) return;
            var c = { time: time, track: 0, cluster: -1, rel: -1, duration: 0 };
            each(b, f.start, f.end, function (g) {
              if (g.id === ID.TRACK) c.track = uint(b, g.start, g.end);
              if (g.id === ID.CLUSTER_POS) c.cluster = uint(b, g.start, g.end);
              if (g.id === ID.REL_POS) c.rel = uint(b, g.start, g.end);
              if (g.id === ID.DURATION) c.duration = uint(b, g.start, g.end);
            });
            if (wanted[c.track] && c.cluster >= 0 && c.rel >= 0) {
              (file.cues[c.track] = file.cues[c.track] || []).push(c);
            }
          });
        });
        return file;
      });
    });
  }

  /* ---------------- one subtitle line ---------------- */

  function parseBlock(b, at, trackNumber) {
    var h = header(b, at);
    if (!h || h.end > b.length) return null;
    var data = null, duration = 0;
    if (h.id === ID.SIMPLE) {
      data = { start: h.start, end: h.end };
    } else if (h.id === ID.GROUP) {
      each(b, h.start, h.end, function (f) {
        if (f.id === ID.BLOCK) data = { start: f.start, end: f.end };
        if (f.id === ID.BLOCK_DURATION) duration = uint(b, f.start, f.end);
      });
    } else {
      return null;
    }
    if (!data) return null;
    var track = vint(b, data.start, false);
    if (!track || track.value !== trackNumber) return null;
    return { payload: b.subarray(track.next + 3, data.end), duration: duration };
  }

  // CueRelativePosition counts from the start of the cluster's data, after a
  // 4-byte ID and a 1–8 byte size. The header length is found once per file.
  function readLine(file, cue) {
    var origin = file.base + cue.cluster + cue.rel;
    if (file.clusterHeader !== null) {
      return range(file.url, origin + file.clusterHeader, 4096).then(function (b) {
        var block = parseBlock(b, 0, cue.track);
        if (block) return block;
        file.clusterHeader = null;
        return readLine(file, cue);
      });
    }
    return range(file.url, origin + 5, 4103).then(function (b) {
      for (var o = 0; o <= 7; o++) {
        var block = parseBlock(b, o, cue.track);
        if (block) { file.clusterHeader = o + 5; return block; }
      }
      return null;
    });
  }

  /* ---------------- text ---------------- */

  var decoder = new TextDecoder('utf-8');

  function cueText(codec, payload) {
    var text = decoder.decode(payload).replace(/\r\n?/g, '\n');
    if (codec === 'S_TEXT/ASS' || codec === 'S_TEXT/SSA') {
      text = text.split(',').slice(8).join(',').replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n');
    }
    if (codec === 'S_TEXT/WEBVTT') return text;
    var escaped = text.replace(/<\/?font[^>]*>/gi, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return escaped.replace(/&lt;(\/?[ibu])&gt;/gi, '<$1>');
  }

  /* ---------------- a showing track ---------------- */

  // `index` is the stream's position in the file, which is how Jellyfin-style
  // MediaStreams number embedded tracks.
  function attach(file, index, video, label, language) {
    var t = file.tracks[index];
    if (!t || t.type !== SUBTITLE || !TEXT_CODECS.test(t.codec)) return null;
    var cues = (file.cues[t.number] || []).slice().sort(function (a, b) { return a.time - b.time; });
    if (!cues.length) return null;

    var textTrack = video.addTextTrack('subtitles', label, language || 'und');
    var secs = function (ticks) { return ticks * file.scale / 1e9; };
    var state = cues.map(function () { return 0; }); // 0 new, 1 loading, 2 done
    var busy = 0;
    var timer = null;
    var failures = 0;

    function add(i, block) {
      var c = cues[i];
      var start = secs(c.time);
      var dur = block.duration || c.duration;
      var end = dur ? start + secs(dur) : (cues[i + 1] ? secs(cues[i + 1].time) : start + 4);
      var text = cueText(t.codec, block.payload);
      if (text.trim()) textTrack.addCue(new VTTCue(start, end, text));
    }

    function pump() {
      if (textTrack.mode !== 'showing' || failures > 5) return;
      var now = video.currentTime || 0;
      for (var i = 0; i < cues.length && busy < PARALLEL; i++) {
        if (state[i]) continue;
        var at = secs(cues[i].time);
        if (at < now - 10) { continue; }
        if (at > now + LOOKAHEAD) break;
        load(i);
      }
    }

    function load(i) {
      state[i] = 1;
      busy++;
      readLine(file, cues[i]).then(function (block) {
        state[i] = 2;
        failures = 0;
        if (block) add(i, block);
      }, function (err) {
        state[i] = 0;
        if (!err || err.status !== 429) failures++;
      }).then(function () {
        busy--;
        pump();
      });
    }

    return {
      textTrack: textTrack,
      lines: cues.length,
      loaded: function () { return state.filter(function (s) { return s === 2; }).length; },
      show: function () {
        textTrack.mode = 'showing';
        failures = 0;
        if (!timer) timer = setInterval(pump, 1000);
        pump();
      },
      hide: function () {
        textTrack.mode = 'disabled';
        if (timer) { clearInterval(timer); timer = null; }
      }
    };
  }

  global.MkvSubs = { open: open, attach: attach };
})(window);
