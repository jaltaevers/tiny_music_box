# Kids Music Tiles

A big-button Spotify player for young kids: tap a picture tile, hear a song.
A static site (GitHub Pages, no build step, no backend) that plays music
through one parent Spotify Premium account via the Web Playback SDK. A
gated parent mode controls which songs appear. No search, no browsing, no
videos, no way for a kid to wander off.

## Status: YouTube migration in progress

This repo (`tiny_music_box`) is a fork of the original Spotify-based app
(`spoti-kiddies`), migrating the playback and data backend from the
Spotify Web API/Web Playback SDK to YouTube's IFrame Player API — to get
out from under Spotify Developer Mode's quota and allowed-user
restrictions — while keeping the kid-facing UI (the tile grid, the
now-playing bar, the Winamp-style visualizer, parent mode's settings)
pixel-for-pixel identical. Everything below this section, and everything
in "Status: Phase 1" right after it, describes that original app; it's
all still accurate for what's in this repo today except where this
section says otherwise.

**What's landed so far:**
- `youtube-player.js` — a hidden-YouTube-IFrame playback engine, built
  behind the exact same interface `player.js` (the Spotify version)
  already exposed (`init`, `playTracks`, `pause`, `resume`, `next`,
  `previous`, `setVolume`, `getState`, `setRepeatMode`, `onStateChange`,
  `onEvent`, `activateElement`). Includes queue/repeat-mode management
  (a single `YT.Player` only ever loads one video at a time, unlike
  Spotify Connect's server-side queue) and a best-effort "is this
  probably an ad?" heuristic with volume ducking — see that file's own
  comments for exactly how, and why it's a guess, never a certainty.
- The hidden-iframe CSS technique (`.yt-hidden-player` in `style.css`) —
  opacity/position-based, not `display:none`/`visibility:hidden`, which
  can silently throttle or stop playback in some browsers.
- `youtube-player-demo.html` / `.js` — a standalone page exercising the
  engine end-to-end (paste any YouTube link or video ID, or several, one
  per line, to test play/pause/skip/previous/volume/progress/the ad
  notice), independent of the rest of this app. Open it directly, or run
  a static server (`python3 -m http.server`, same as "Local dev" below)
  and visit `/youtube-player-demo.html`.

**Not yet touched — still 100% the original Spotify app, unchanged:**
`app.js`, `auth.js`, `config.js`, `spotify-api.js`, `store.js`,
`kid-mode.js`, `parent-mode.js`. Wiring `youtube-player.js` into the real
app means replacing how tiles get their identity first: today every tile
holds a Spotify `uri` (`spotify:track:...`) sourced from Spotify search/
playlist import, and `youtube-player.js`'s `playTracks()` has no way to
turn that into a YouTube video ID. That's the next step — "Data & Search
Substitution": a YouTube Data API–backed replacement for
`spotify-api.js`'s search/playlist-import, a `youtube:video:<id>` URI
scheme in `store.js` (replacing `TRACK_URI_RE`/`tileFromTrack`'s Spotify
shape), and rewiring the small number of call sites in `app.js` and
`kid-mode.js` that touch either. Once that lands, `auth.js` (Spotify
OAuth) and the login screen go away entirely — YouTube playback needs no
user login.

## Status: Phase 1 — the real app is live

Phase 0 confirmed the Spotify Web Playback SDK plays reliably (including
recovering automatically from a brief "Device not found" race right after
connecting, which showed up during testing) — for a single tapped song.
The real app's default "continue to next tile" behavior instead queues
the whole grid in one request, which Phase 0 never exercised; if that
untested request fails, tapping a tile now falls back to the single-song
shape Phase 0 did prove reliable rather than showing an error, so a kid
still hears something even if the auto-advance part doesn't take. The
full app now lives at the site root:

```
https://jaltaevers.github.io/Spoti-Kiddies/
```

`/spike/` is left in place as the original debug tool, untouched — useful
if playback ever needs troubleshooting again without the full app's UI in
the way.

### One required setup step before the real app will log in

The spike and the real app are served from different paths
(`/spike/` vs. the site root), and Spotify checks the Redirect URI
**exactly** — so the real app needs its own entry added, separately from
the spike's:

1. Go to the app's settings at the
   [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Add this **Redirect URI** (trailing slash included):
   `https://jaltaevers.github.io/Spoti-Kiddies/`
3. Save.

That's it — the Client ID is already wired in, and Pages auto-deploys on
every push, so nothing else is needed.

#### If login still fails with a redirect URI error

Spotify shows its own error page (not this app's) when `redirect_uri`
doesn't match a registered URI exactly, so a parent debugging this from the
app itself can't see why. The login screen has a **"Trouble logging in?"**
section that shows the exact address the app is sending and a button to
copy it — open that and paste the value straight into the dashboard to
rule out a typo. Beyond a plain typo, the usual causes are:

- **Trailing slash.** `https://jaltaevers.github.io/Spoti-Kiddies/` and
  the same address without the trailing slash are different Redirect
  URIs to Spotify — the one with the slash is the one this app sends.
- **Not actually saved.** Spotify's dashboard adds the URI to a list when
  you click "Add", but it isn't applied until you also click **Save** at
  the bottom of the page.
- **`localhost` is never accepted**, even if you register it — see
  "Local dev" below.
- **Opened as a local file** (double-clicked `index.html` instead of
  loading it through a server) — there's no valid address to register in
  that case; see "Local dev" below.

### First run

With no songs configured yet, opening the site goes straight to parent
mode (there's nothing to show in kid mode with zero tiles). The **Quick
setup** box at the top is the fast path: enter the kid's name (optional —
shows as a small greeting in kid mode and in the browser tab title) and
paste a link to a playlist you own or collaborate on (Spotify's
Development Mode restrictions block reading other accounts' playlists),
then **Load playlist as tiles** — that's it, tap **Save** and **Done** to
see the kid-facing grid.

For more control, further down: search for individual songs, drag to
reorder, override any tile with an emoji + color instead of album art,
and set end-of-song behavior, a max volume cap, a sleep timer, and hide
explicit tracks (default on). There's no limit on how many songs a kid
can have — kid mode's grid sizes itself to fit however many tiles exist,
each tile capped at a comfortable size so a handful of songs doesn't
turn into a few giant tiles filling the screen.

**Tile style** (in Settings) switches every tile between **Cover art**
(album art, or a tile's own emoji + color override if it has one — the
default) and **Simple** (an emoji plus the song's name on every tile, for
a kid who reads and would rather pick by name than recognize a photo).
A manual emoji + color override always takes priority over either mode's
default art.

Parent mode is reachable any time by press-and-holding the small circle in
the top-right corner of kid mode for 3 seconds, then entering the PIN (set
on first use). The PIN is shared by the whole device, not per kid.

### Multiple kids

The **Kids** section at the top of parent mode holds one tab per kid, each
with their own name, songs, and settings (volume cap, sleep timer, end-of-
song behavior, explicit filter). Tap a tab to switch who you're editing —
that's also who kid mode shows once you hit **Done**. **+ Add another
kid** creates a new, empty one; the ✕ on a tab removes that kid and their
songs for good (only shown once there's more than one kid, so there's
always someone for kid mode to display). Switching tabs with unsaved
changes asks first, same as **Done** does.

Whenever **Load playlist as tiles** succeeds, that playlist is remembered
for that kid — an **Open playlist in Spotify ↗** link appears in Quick
setup so you can jump into the real Spotify app to add, remove, or
reorder songs, then come back and tap **Load playlist as tiles** again
(the link and the playlist field both stay filled in) to pull the update.

### Known simplifications worth knowing about

- **Drag-to-reorder** in the song list works but is a simple implementation
  (the row follows your finger/cursor and drops at the nearest slot) rather
  than a polished live-reordering animation.
- **Emoji/color tile overrides** use the browser's native emoji keyboard and
  color picker (via a plain text field and `<input type="color">`) rather
  than a custom picker UI — quick to build, and tablets already have a
  built-in emoji keyboard.
- **The "~6 months" refresh-token expiry warning** in the account panel is
  an estimate (Spotify doesn't publish an exact day count), not a precise
  countdown.
- **The Winamp-style visualizer** on the now-playing bar (the small button
  next to play/pause turns it on or off, and remembers the choice per kid)
  is a stylized animation, not a real spectrum analyzer — the Spotify Web
  Playback SDK plays through its own DRM-protected pipeline with no
  accessible audio to actually analyze, so the bars are driven by a
  synthetic signal shaped to swell and settle the way real music does,
  keyed only to actual play/pause state.

## Local dev

`http://127.0.0.1:<port>/` also works for iterating from a computer —
register that as a Redirect URI too (both `/` and `/spike/` variants, as
needed) — but isn't required for the deployed site above. Use
`127.0.0.1`, not `localhost`: Spotify rejects `localhost` redirect URIs
outright, even if you register one — so if your dev server's own startup
message prints a `localhost` URL, swap in `127.0.0.1` before opening it.
Opening `index.html` straight from disk (a `file://` address) won't work
either — Spotify has no valid address to redirect back to in that case,
so it needs to be served over `http://` by something, however minimal.

## Phase 0 spike (historical)

`SPIKE.md` has the original feasibility-test checklist and the Spotify API
research done before writing any playback code, including the Feb/Mar 2026
Development Mode migration notes (which endpoints changed, the playlist
ownership restriction, refresh token expiry). Still accurate background
reading if something Spotify-API-related needs revisiting.
