# Silo for LG webOS

An unofficial **client** app for [Silo](https://siloserver.org/), the self-hosted
media server. Silo itself is the server — this is only the LG TV front end, the
equivalent of Silo's Apple TV / Android TV apps.

It talks to Silo's **Jellyfin-compatible API**, which Silo exposes on a separate
address from its web UI (see Silo's [Jellyfin-compatible app docs](https://siloserver.org/docs/jellyfin-apps)).

## What it does

- **Sign in with Quick Connect** — the TV shows a six-digit code, you approve it
  at `http://your-server/activate` from your phone. No password typed on a remote.
- **Or sign in with a password** — use the `username#Profile` form Silo expects.
- **Continue watching**, **recently added** per library, and a **library grid**.
- **Search** across movies and series (the first tile in the Libraries row).
- **Settings** (the second tile in the Libraries row): profile and server info,
  sign out, continue-watching toggle, how many recently-added rows to show,
  seek step, app version and device ID.
- **Detail view** with poster, backdrop, year, runtime, rating and overview.
- **Series** show their episode list.
- **Playback** with resume from where you stopped, falling back from direct play
  to transcoding if the TV cannot decode the source.
- **Progress reporting** to `/Sessions/Playing`, `/Progress` and `/Stopped`, so
  Silo's own apps and other clients see your position.

## Requirements

- A rooted LG webOS TV with Homebrew Channel (needed to install unsigned apps).
- A Silo server with **third-party access** enabled, and its
  **Jellyfin-compatible address** — ask whoever runs the server.

## Build

```sh
python3 build.py            # -> silo-webos.ipk
```

## Install

Via Homebrew Channel (copy the `.ipk` to the TV), or over SSH:

```sh
scp silo-webos.ipk root@<tv-ip>:/tmp/
ssh root@<tv-ip> "luna-send-pub -i 'luna://com.webos.appInstallService/dev/install' \
  '{\"id\":\"org.silo.webos\",\"ipkUrl\":\"/tmp/silo-webos.ipk\",\"subscribe\":true}'"
```

## Remote keys

| Key | Action |
|---|---|
| Arrows | Move focus (scrolls rows and grids as needed) |
| OK / Enter | Select, or open the on-screen keyboard on a text field |
| Back | Up a level; exits from the home screen |
| OK / Play / Pause | Play-pause in the player |
| Left / Right (or Rewind / Fast-forward) | Seek by the configured step (10/30/60 s) |

## Layout

```
appinfo.json     webOS manifest
index.html       screens: connect, home, library grid, detail, player
css/app.css      TV styling and focus rings
js/api.js        Jellyfin-compatible client (auth, Quick Connect, media, sessions)
js/app.js        screen routing, remote-key navigation, playback
build.py         builds the IPK
```

## Notes

- The app is unsigned; it is packaged for rooted TVs and installed through
  Homebrew Channel.
- The sign-in token is stored in the app's local storage on the TV only.
- Unofficial and unaffiliated with Silo Media L.L.C.
