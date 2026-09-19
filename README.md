# Kids Music Tiles

A big-button music player for young kids: tap a picture tile, hear a song.
A static site (GitHub Pages, no build step, no backend). A gated parent
mode controls which songs appear. No search, no browsing, no way for a
kid to wander off.

## Status: YouTube-backed, in production

This repo (`tiny_music_box`) is a fork of the original Spotify-based app
(`spoti-kiddies`), rebuilt on YouTube's IFrame Player API instead of the
Spotify Web API/Web Playback SDK — to get out from under Spotify
Developer Mode's quota and allowed-user restrictions — while keeping the
kid-facing UI (the tile grid, the now-playing bar, the Winamp-style
visualizer, parent mode's settings) pixel-for-pixel identical. Spotify is
fully gone: no login, no account, no OAuth. The live site:

```
https://jaltaevers.github.io/tiny_music_box/
```

**How playback works:** `youtube-player.js` drives a hidden YouTube
`<iframe>` (see `.yt-hidden-player` in `style.css` for the hiding
technique — opacity/position-based, not `display:none`, which can
silently throttle or stop playback in some browsers) behind the exact
same interface the original Spotify player exposed (`init`, `playTracks`,
`pause`, `resume`, `next`, `previous`, `setVolume`, `onStateChange`,
`onEvent`, `activateElement`) — so `kid-mode.js`, the entire kid-facing
control surface, needed no changes at all. It also includes a best-effort
"is this probably an ad?" heuristic (comparing the live video's duration
against what a tile expects) with volume ducking while one's suspected —
see that file's own comments for exactly how, and why it's a guess, never
a certainty (the IFrame API has no documented way to detect an ad
directly) — and registers a real Media Session (play/pause/skip on the
lock screen/notification shade, with the actual title/artist/artwork),
which needs a whole tile object rather than a bare uri to work from —
see `kid-mode.js`'s `playTracks()` call sites. `youtube-player-demo.html`/
`.js` is a standalone page that exercises the engine on its own,
independent of the rest of the app — useful for testing playback/
controls/the ad notice/Media Session in isolation.

**How adding songs works:** parent mode's "Add songs" takes one or more
YouTube links or video IDs (one per line) and looks each up via YouTube's
public **oEmbed** endpoint (`youtube-api.js`) — real title, channel name,
and thumbnail, with **no API key, no quota, no Google account needed**.
This is deliberately a *link-paste* flow, not a *type-a-query* search: a
parent finds the video on YouTube themselves (in another tab, the
YouTube app, wherever) and pastes the link here to add it. That tradeoff
is what makes this work without any credential setup at all.

**Known gaps, and what would close them:**
- **No typed, in-app search** ("type a song name, see results") — oEmbed
  needs a specific video URL, not a query. Real search needs the YouTube
  Data API v3, which needs an API key (a Google Cloud project) that only
  an account holder can create.
- **No duration metadata** — oEmbed doesn't return it, so every tile
  added this way carries `durationMs: null`. The ad-detection heuristic
  above compares live duration against an *expected* one, so it simply
  doesn't run for these tiles rather than guessing wrong — same Data API
  key would fix this too (`videos.list?part=contentDetails`).
- **No "hide explicit tracks" filtering for real** — nothing in YouTube's
  public metadata flags a video explicit the way Spotify's catalog did,
  so that toggle is currently a no-op for songs added this way.
- **No YouTube Premium / ad-free detection, and — the bigger one —
  playback pauses when you switch apps or lock the screen.** These are
  the same underlying restriction. Confirmed via research, current as of
  2026: YouTube treats background/lock-screen continuation as a
  Premium-exclusive feature and actively enforces it in its own
  player — for the youtube.com site, for third-party mobile browsers,
  and specifically for third-party `<iframe>` embeds like this one —
  citing their "Device and Network Abuse" policy. That's YouTube's own
  player pausing itself the moment the page isn't visible; it is not a
  bug here, and nothing client-side (Media Session API, resizing the
  iframe, anything else in this app's control) touches it, because the
  restriction is enforced by YouTube's backend recognizing "this tab
  isn't visible," not by generic browser tab-throttling.

  There is also no way for this app's own page to make the *hidden
  iframe* play as a signed-in, Premium account — the iframe is a
  separate, cross-origin browsing context with its own cookie jar, so a
  "Login" button in this app's own UI cannot establish a YouTube session
  inside it. The only thing that could ever help is the *browser itself*
  already having an ambient signed-in Premium session, and this app
  embeds via `youtube-nocookie.com` by default specifically to *avoid*
  reading that session, for privacy. Parent mode's Settings has an
  opt-in **"Background playback (experimental)"** toggle
  (`useSignedInYouTubeSession` in the store, `useSignedInSession` on
  `createYouTubePlayer`) that switches to the regular, cookied
  `youtube.com` embed instead, purely to give that ambient-session path
  a chance — off by default, device-wide (like the PIN), reloads the app
  to apply since the embed domain is fixed at player construction time.
  Explained to whoever might flip it on, in the UI itself, not just here:
  it isn't guaranteed to do anything even when the browser *is* signed
  into Premium, since the restriction reads as account-gated rather than
  purely cookie-gated. The volume-ducking ad heuristic above remains the
  practical, always-on mitigation regardless of this toggle.

## First run

With no songs configured yet, opening the site goes straight to parent
mode (there's nothing to show in kid mode with zero tiles). Under **Add
songs**, paste a YouTube link or video ID per line and tap **Look up** —
each one resolves to its real title, channel, and thumbnail before you
add it. Tap **Save** and **Done** to see the kid-facing grid.

Further down: drag tiles to reorder, override any tile with an emoji +
color instead of the video's thumbnail, and set end-of-song behavior, a
max volume cap, a sleep timer, and hide explicit tracks (see the gap
noted above — currently a no-op for YouTube-sourced tiles). There's no
limit on how many songs a kid can have — kid mode's grid sizes itself to
fit however many tiles exist, each tile capped at a comfortable size so a
handful of songs doesn't turn into a few giant tiles filling the screen.

**Tile style** (in Settings) switches every tile between **Cover art**
(the video's thumbnail, or a tile's own emoji + color override if it has
one — the default) and **Simple** (an emoji plus the song's name on every
tile, for a kid who reads and would rather pick by name than recognize a
photo — simple mode also drops the now-playing bar entirely, using the
tile itself as the play/pause/resume control).

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

### Known simplifications worth knowing about

- **Drag-to-reorder** in the song list works but is a simple implementation
  (the row follows your finger/cursor and drops at the nearest slot) rather
  than a polished live-reordering animation.
- **Emoji/color tile overrides** use the browser's native emoji keyboard and
  color picker (via a plain text field and `<input type="color">`) rather
  than a custom picker UI — quick to build, and tablets already have a
  built-in emoji keyboard.
- **The Winamp-style visualizer** on the now-playing bar (the small button
  next to play/pause turns it on or off, and remembers the choice per kid)
  is a stylized animation, not a real spectrum analyzer — playback comes
  from a hidden, cross-origin `<iframe>` with no accessible `<audio>`
  element or MediaStream in this page's own DOM, so there's nothing a Web
  Audio AnalyserNode could attach to. The bars are driven by a synthetic
  signal shaped to swell and settle the way real music does, keyed only
  to actual play/pause state.

## Local dev

Any static file server works — for example `python3 -m http.server` from
this folder, then open the `http://127.0.0.1:<port>/` address it prints.
Opening `index.html` straight from disk (a `file://` address) won't work:
browsers refuse to load an external `type="module"` script (`app.js`)
under `file://` at all, regardless of what it does — the page shows a
notice explaining this rather than failing silently.

## Phase 0 spike & Spotify history (historical)

`SPIKE.md`, and everything about Spotify OAuth/Web Playback SDK it
describes, is preserved as a historical record of `spoti-kiddies` (the
app this was forked from) rather than kept up to date — this repo no
longer uses Spotify for anything. Worth reading only if working on
`spoti-kiddies` itself, or curious how the original app's Spotify
integration worked before this fork replaced it.
