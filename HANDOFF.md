# Handoff: Silo client for LG webOS

Unofficial TV client for [Silo](https://siloserver.org/), a self-hosted media
server. Built for one rooted LG C2 and installed on it. This document is for
someone reviewing the code cold.

**Status:** v0.6.0, installed on the TV and in use. Sign-in, browsing, search,
settings, playback, resume and progress reporting all work, verified by
`tools/smoke_test.py` (9/9). Subtitles work but are crippled by server-side
extraction latency (see Issues #1).

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
lint pipeline; it is only now becoming a git repo, with a single initial commit.

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
js/app.js         screens, remote-key navigation, playback, subtitles
js/seed.js        session seed (GITIGNORED — contains a live token)
js/seed.example.js template for the above
build.py          builds the IPK in pure Python (ar + tarfile)
make-icons.py     generates icons/splash with Pillow
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
python3 tools/smoke_test.py               # 9 checks
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
openSearch, live search results, and both tiles reached with real key presses.

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

1. **Subtitle extraction is pathologically slow (server-side).**
   `GET /Videos/{id}/{mediaSourceId}/Subtitles/{index}/Stream.vtt` measured at
   **0.4 s, 75 s, 149.6 s**, with 2 of 3 tracks timing out at 150 s. One film
   has 14 text tracks. Nothing appears to be cached between requests. The app
   pre-fetches up to 3 tracks in the background (should be 1 — each is ~150 s),
   shows a live elapsed counter, and times out at 120 s.
2. **MediaSource IDs are not stable.** A `MediaSourceId` captured earlier later
   returned 404 from the subtitle endpoint. The app always takes `source.Id`
   from a fresh `PlaybackInfo`, so it works, but any caching of IDs is unsafe.
3. **`<track>` fetches are opaque without CORS.** A cross-origin `<track>`
   silently yields zero cues even though the endpoint sends
   `access-control-allow-origin: *`. Current workaround: `fetch()` the WebVTT,
   wrap in a `Blob`, use a `blob:` URL, plus `crossOrigin="anonymous"`.
4. **No audio-track switching.** Direct play cannot remux and the server has
   transcoding off, so the UI only *displays* the active audio stream.
5. **4K/HDR.** Direct play is confirmed 4K (decoder reported
   `3840x1608` HEVC ~25 Mbit/s). The LG "4K/HDR" OSD never appears — expected
   for third-party apps, but HDR10/Dolby Vision signalling is **unverified**
   and may not be reaching the panel.
6. **Version picker is client-side only.** The chosen source is passed via
   `MediaSourceId` on the stream URL, not requested in the `PlaybackInfo` POST.
   Session reporting may therefore not reflect the chosen version.
7. **Gaps:** no watchlist, no season grouping (a series shows one flat episode
   row), no next-episode autoplay, no `::cue` subtitle styling, 120-item pages
   with auto-load, no tests, no linting.

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
- **Written but never observed working:** subtitle rendering (network path
  proven, pixels never seen), HLS fallback, playing an episode from a series.
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
