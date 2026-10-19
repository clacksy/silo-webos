# Handoff: Silo client for LG webOS

Unofficial TV client for [Silo](https://siloserver.org/), a self-hosted media
server. Built for one rooted LG C2 and installed on it. This document is for
someone reviewing the code cold.

**Status:** v0.9.2, installed on the TV and in use. Sign-in, browsing (with
sort, filter and A–Z jump), series with seasons and Next Up, search, settings,
playback, resume and progress reporting all work, verified by
`tools/smoke_test.py` (30/30). Embedded text subtitles in MKV files now appear
within seconds, read straight from the file (see "Subtitles" in section 3).

**Read section 6 first if you are reviewing this.**

---

## 1. Where everything is

| Thing | Location |
|---|---|
| Source | `~/silo-webos` (this repo) |
| Built package | `silo-webos.ipk` (gitignored, produced by `build.py`) |
| Installed on TV | `/media/developer/apps/usr/palm/applications/org.silo.webos/` |
| TV access | `ssh c2tv` (root, key-only dropbear; host is DHCP, currently `192.168.1.233`) |

There is no CI, no linter, and no test suite. This folder was originally created
inside an unrelated Ember repository and moved out to keep it off that project's
lint pipeline; it became a git repo on 2026-10-19.

## 2. Environment facts

- **TV:** LG `OLED55C24LA` (C2), board `O22_DVB_EU`, webOS `10.3.1-3006`
  (webOS 25), firmware `33.31.68`, 2 GB RAM, rooted via Homebrew Channel.
- **Server, Silo UI:** `https://silo.example.com`
- **Server, Jellyfin-compatible API:** `https://silo-jf.example.com`
  - `/System/Info/Public` reports `ProductName: "Jellyfin Server"`,
    `Version: "10.12.0"`, `ServerName: "Silo"`.
  - CORS: API responses send `access-control-allow-origin: *`, including the
    subtitle endpoint.
- **Account/profile:** `ymknyxsq#Main`, 17 libraries, `Movies` alone reports
  `TotalRecordCount: 68069`.
- **Auth model:** the app signs in with Jellyfin-compatible auth. A session can
  be pre-seeded in `js/seed.js` (gitignored) to skip the sign-in screen.

## 3. Architecture

Vanilla JS, no framework, no bundler. ~2,000 lines total. The only "build" is
packaging.

```
appinfo.json      webOS manifest (id org.silo.webos, 1920x1080, disableBackHistoryAPI)
index.html        all screens in one document
css/app.css       dark TV styling, focus rings, player overlay
js/api.js         Jellyfin-compatible API client (auth, Quick Connect, media, sessions)
js/mkvsubs.js     reads embedded subtitle lines straight from MKV files (range requests)
js/app.js         screens, remote-key navigation, playback, subtitles
js/seed.js        session seed (GITIGNORED — contains a live token)
js/seed.example.js template for the above
build.py          builds the IPK in pure Python (ar + tarfile)
make-icons.py     generates icons/splash with Pillow
tools/smoke_test.py  DevTools smoke test run against the TV (not packaged)
```

### Screens

`connect`, `home`, `grid`, `detail`, `search`, `settings`, `player`. One
`<section class="screen">` each, toggled with `.active`. `state.screen` drives
key dispatch.

### Remote control

A single `keydown` listener switches on `state.screen`. Key codes used:
`37/38/39/40` arrows, `13` OK, `461` Back (also `27`/`8` for dev),
`415` play, `19` pause, `417` fast-forward, `412` rewind.

Focus is an index per screen plus a `.focused` class; `ensureVisible()` scrolls
a container using `getBoundingClientRect()` maths (this replaced
`scrollIntoView`, which was unreliable and caused a real bug where home rows
below the fold were unreachable).

### Playback

- Direct play: `GET /Videos/{id}/stream?static=true&MediaSourceId=…&api_key=…`,
  assigned to a plain `<video>` element.
- HLS fallback: `/Videos/{id}/master.m3u8?…` — **untested**: this server
  reports `SupportsTranscoding: false`, so the path may 404.
- Progress: `POST /Sessions/Playing`, `/Sessions/Playing/Progress` (every 10 s),
  `/Sessions/Playing/Stopped`, with `PositionTicks` (100 ns ticks).
- Resume: `UserData.PlaybackPositionTicks` from the item.
- Multiple versions: `PlaybackInfo` returns several `MediaSources`; the app
  defaults to highest `MediaStreams[Video].Height` then highest `BitRate`, with
  a `Version:` button on the detail screen to cycle.

### Series, library and player behaviour (0.8.0)

- **Series page:** season tabs (Left/Right, loads after a 350 ms pause), an
  episode row per season (✓ = watched), and Play aimed at Next Up
  ("Resume S2:E3 from 12m"). Returning from the player re-reads Next Up and
  the shown season (two requests).
- **Next episode:** when an episode ends, a 10 s countdown plays the next one
  (OK now, Back cancels). Setting: "Play next episode automatically".
- **Home:** Continue watching, Next up, Favourites, Recently added, Libraries.
- **Library grid:** chips for Sort (Name, Date added, Year, Rating) and Show
  (All, Unwatched, Favourites); with Name sort, a letter row jumps via
  `NameStartsWithOrGreater`. Each change is one 120-item request.
- **Seeking:** repeated/held Left/Right accelerate (step, 1, 5, 10 min) and
  are applied once presses stop, so a long scrub is one new range request.
- **Pickers (0.9):** a modal list (`openPicker`) used for subtitles (full
  track names, duplicates numbered), audio and genre. Subtitle and audio
  choices are remembered by language and applied to the next play; both can
  be cleared in Settings.
- **Audio tracks:** `video.audioTracks` works on webOS 25 for MKV and lists
  only tracks the TV can decode (the 4K Evil Dead Burn remux: server lists 6
  with TrueHD first, the TV lists 5). Names come from the server only when
  the counts match; otherwise "EN 1", "EN 2"… Switching was confirmed via
  DevTools (enabled flag moves, playback continues), not by ear.
- **Profiles (0.9.2):** each Silo profile is a separate sign-in (Quick
  Connect asks which profile to approve; password sign-in uses
  `user#Profile`). Every session is kept in `localStorage['silo.profiles']`;
  Settings → Profile switches or adds one, and Back from the add screen
  returns to the previous profile. `seed.js` is applied once per token
  (`silo.seedApplied`), so a switched profile survives restarts. Boot tries
  the current, then other saved profiles; it forgets a profile only on 401,
  and keeps sign-ins when the server is unreachable. Switching with a second
  real profile is untested (only one profile was signed in).
- **Grid memory:** posters more than 240 cards from the cursor are unloaded
  and reloaded on return.
- **Recovery:** "Buffering…" status; a mid-film error reconnects at the last
  position (up to 3 times, backing off); HLS only if the source can
  transcode; a 401 returns to sign-in with a message; the Home button pauses
  and reports position.

### Subtitles

Only text subtitles are offered; image subtitles (Blu-ray PGS) are skipped.

1. **Embedded track in an MKV** → `js/mkvsubs.js`. MKV files (mkvmerge output)
   index every subtitle line in their `Cues` element. The app range-requests
   the file header and the index once (~130 KB, ~2.5 s), then fetches each
   line (a few hundred bytes) just ahead of the playback position, at most two
   requests at a time, into a `TextTrack` via `addTextTrack()` + `VTTCue`.
   Measured on the TV: subtitles on in ~4 s, correct line on screen within
   seconds of a 30-minute seek, 45 small requests for the whole test.
2. **Anything else** (no index, not MKV, sidecar `.srt`) → the server's
   `/Subtitles/{index}/Stream.vtt`, fetched and attached as a `blob:` track.
   Sidecars return in 0.4 s. Embedded tracks via this path cost one
   full-file read on the server: 190 s for a 20 GB remux, after which every
   track of that file is cached and returns in 0.3 s. Timeout is 360 s,
   because aborting early appears to discard the server's work.

The webOS `<video>` element does not expose embedded MKV text tracks
(`textTracks` is empty), so there is no native path.

### Packaging and deploy

`build.py` writes an IPK by hand: `ar` archive of `debian-binary`,
`control.tar.gz`, `data.tar.gz` (payload under
`usr/palm/applications/org.silo.webos/`). Push and install over SSH:

```sh
cd ~/silo-webos && python3 build.py
ssh c2tv 'cat > /tmp/silo-webos.ipk' < silo-webos.ipk
ssh c2tv "luna-send -i luna://com.webos.appInstallService/dev/install \
  '{\"id\":\"org.silo.webos\",\"ipkUrl\":\"/tmp/silo-webos.ipk\",\"subscribe\":true}'"
ssh c2tv "sleep 5 | luna-send -n 1 luna://com.webos.applicationManager/launch \
  '{\"id\":\"org.silo.webos\"}'"
```

### Verification without a screen

The app puts its state in `document.title` — e.g.
`Silo · home · 6 rows · ymknyxsq#Main` or `Silo · player · 3840x2160 · cues 812`.
Read it over SSH:

```sh
ssh c2tv 'curl -s http://127.0.0.1:9998/json | grep -o "\"title\": *\"[^\"]*\""'
```

A red error bar (`#fatal`) also surfaces uncaught exceptions and unhandled
rejections on screen, because console output is invisible on a TV.

## 3a. Testing (added after review)

There is a **DevTools smoke test** at `tools/smoke_test.py`. It drives the app
running on the TV from a Mac:

```sh
ssh -f -N -L 9998:127.0.0.1:9998 c2tv     # tunnel the TV's devtools port
python3 tools/smoke_test.py               # 30 checks
```

It uses two mechanisms:

1. `window.__silo` — a diagnostics hook in `js/app.js` exposing `api`, `state`,
   `openSearch`, `openSettings`, `runSearch`, `enterHome`, etc. Needed because
   the whole app is wrapped in an IIFE, so nothing is visible in page scope.
2. `Input.dispatchKeyEvent` — sends real arrow/Enter/Back key presses, so the
   remote-control path is exercised end to end, not just the functions.

**Why this exists:** the first four builds were only verified by file presence
plus `document.title` telemetry. That is not testing. A later patch deleted the
entire settings and search implementation while leaving their call sites behind,
and it went unnoticed because nothing ever *exercised* those screens. The smoke
test now covers: openSettings, settings row rendering, `api.publicInfo()`,
openSearch, live search results, both tiles reached with real key presses,
typing and Backspace in the search box, searching again from the results,
Back closing the keyboard, Back from detail returning to search, the series page
(seasons, Next Up Play target, season switching with keys), the library grid
(title count, A–Z jump, sort cycling, genre picker), and a final check that the `#fatal`
error bar stayed empty.

Known blind spots: playback control (needs content and a person watching),
subtitle rendering (same), and anything visual — there is no screenshot path.

## 3b. Where to start reading

`js/app.js` is one IIFE, ~1,400 lines, in this order: helpers → rows → home →
library grid → detail → player → settings → search → back handling → keyboard
dispatch → wiring → diagnostics hook → boot. `js/api.js` is a thin
Jellyfin-compatible client. `build.py` is the whole "build".

Review order I would suggest: `build.py` (5 min, tells you nothing is hidden),
`js/api.js` (30 min, the contract), then `js/app.js`.

## 4. Known issues

1. **The server rate-limits (HTTP 429), and it is a shared server.** Bursts of
   API calls get 429s. Keep request counts low: no background prefetching, no
   warming jobs, nothing that makes the server read whole files on spec.
   Server-side subtitle extraction reads the entire file, so the app only
   triggers it when someone selects a track that `mkvsubs.js` cannot read.
   (Earlier "nothing is cached" notes were wrong: the old 120 s client timeout
   was shorter than the extraction, so it never finished.)
2. **MediaSource IDs are not stable.** A `MediaSourceId` captured earlier later
   returned 404 from the subtitle endpoint. The app always takes `source.Id`
   from a fresh `PlaybackInfo`, so it works, but any caching of IDs is unsafe.
3. **Image subtitles (PGS) are not supported.** Many Blu-ray remuxes have
   only PGS tracks, and the "best" (4K) version of a film is often one of
   them. Supporting them means decoding PGS in JS and drawing to a canvas;
   `mkvsubs.js` can already locate the blocks the same way.
4. **Audio tracks the TV cannot decode are invisible.** Probably TrueHD
   (and possibly DTS-HD); the server cannot transcode, so those tracks cannot
   be played at all. See "Audio tracks" above.
5. **4K/HDR.** Direct play is confirmed 4K (decoder reported
   `3840x1608` HEVC ~25 Mbit/s). The LG "4K/HDR" OSD never appears — expected
   for third-party apps, but HDR10/Dolby Vision signalling is **unverified**
   and may not be reaching the panel.
6. **Version picker is client-side only.** The chosen source is passed via
   `MediaSourceId` on the stream URL, not requested in the `PlaybackInfo` POST.
   Session reporting may therefore not reflect the chosen version.
7. **Gaps:** image (PGS) subtitles, no `::cue`
   styling, the grid keeps every loaded card node (images are trimmed), no
   unit tests, no linting. The 0.8–0.9 layouts (chips, season tabs, picker)
   were checked via DevTools only, never by eye.

## 6. Reviewer's guide — what I would scrutinise

1. **Navigation architecture.** Three near-duplicate implementations (row nav,
   grid nav, settings nav), each with its own index state and its own
   left/right/up/down rules. It works and is tested, but it is the thing most
   likely to break when seasons and a watchlist get added. Restructure?
2. **Subtitle workaround.** `fetch()` → `Blob` → `blob:` URL. Is the blob URL
   revoked correctly (currently on track clear)? Should `crossOrigin` be set at
   all once we use blobs? Is there a supported webOS path I have missed?
3. **Error handling.** There are many `catch (e) {}` with a comment. They keep
   the UI alive, but they also hid the subtitle failure for a while. Which of
   these should surface to the user?
4. **Seeded session.** `js/seed.js` holds a token so the TV skips sign-in. Is
   that acceptable for a personal TV device, or should the app always use
   Quick Connect and drop the seed entirely?
5. **Version selection.** The chosen `MediaSource` is passed as
   `MediaSourceId` on the stream URL, not in the `PlaybackInfo` POST, so session
   reporting may not reflect it.
6. **Playback robustness.** Direct play only; the HLS fallback has never been
   exercised because this server reports `SupportsTranscoding: false`.

### Honest confidence levels

- **Tested and working:** sign-in, browse, search, settings, grid paging,
  detail, watched/favourite, resume reporting. Covered by the smoke test.
- **Observed via DevTools, pixels never seen:** MKV subtitles (cues loaded
  and active at the right time after a seek, on the TV).
- **Written but never observed working:** HLS fallback, playing an episode
  from a series, the server-extraction subtitle path end to end on the TV.
- **Never verified at all:** HDR/Dolby Vision actually reaching the panel,
  audio passthrough, behaviour on any TV other than this one.

Everything visual is unverified. There is no screenshot path from the TV; all
confirmation came from `document.title` telemetry and the DevTools protocol.

## 5. Questions worth a second opinion

1. Is `fetch()` → `Blob` → `blob:` URL the right way to attach WebVTT on
   webOS, or is there a cleaner supported path (e.g. `crossorigin` on the
   `<video>` element, or a `data:` URL)?
2. Does webOS expose an API to signal HDR/4K so the TV's own OSD appears, and
   is an HTML5 `<video>` on webOS 25 able to pass HDR10/DV through?
3. Is ~150 s per subtitle track plausible for Silo's Jellyfin-compat layer, or
   is there a cheaper endpoint/parameter (pre-extracted sidecars, position
   offsets, `.srt` instead of `.vtt`)?
4. The focus/navigation code is hand-rolled and duplicated per screen — worth
   restructuring before adding seasons/watchlist?

### Answers (review, 2026-10-19)

1. The `<track>` failure was CORS: a track's fetch mode comes from the
   `<video>` element's `crossorigin`, not the track's. `blob:` worked; MKV
   subtitles now use `addTextTrack()` + `VTTCue`, which avoids `<track>`.
2. No public webOS API shows the HDR badge for a web app. To check HDR is
   reaching the panel, open Picture Mode during playback: the mode names
   change (e.g. "Cinema (HDR)", "Dolby Vision Cinema") when it is.
3. Plausible: extraction reads the whole file. Answered by `mkvsubs.js`.
4. Yes, restructure into one shared focus-list helper plus a navigation stack
   before seasons/watchlist. Back now returns to the screen detail was opened
   from, but that is a per-case fix, not a stack.
