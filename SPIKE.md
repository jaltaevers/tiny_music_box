# Phase 0 Spike — what to test, and what "pass" looks like

Goal: find out whether the Spotify Web Playback SDK can reliably play audio
on the actual tablet the kids will use, in the actual conditions it'll be
used in, **before** any time goes into the real tile-grid app. If it can't,
the fallback is Spotify Connect remote control instead (the tablet sends
play commands to another already-playing Spotify device) — `player.js` is
already written behind a small interface (`init`, `playTracks`, `pause`,
`resume`, `next`, `previous`, `setVolume`, `getState`, `onStateChange`) so
that swap wouldn't require touching the rest of the app.

## One-time setup

See the "One-time setup" section in [`README.md`](README.md) first: enable
GitHub Pages, create the Spotify app, register the Redirect URI, and send
the Client ID back in chat so it can be wired into `spike/config.js` for
you. Come back here once you can load the page.

**Always open the page at the URL ending in `/spike/` (trailing slash),
not `/spike/index.html` and not `/spike` without the slash.** The redirect
URI is computed from whatever URL the page is actually loaded at, so if
that ever drifts from exactly what's registered in the dashboard, login
will fail with a "redirect URI mismatch" error from Spotify — and since
that error comes from Spotify's own page, not this one, it doesn't say
what actually went wrong. If that happens, the login screen has a
"Trouble logging in?" section that shows the exact address it's sending,
to check against the dashboard or copy in directly. Testing locally,
double check it's `http://127.0.0.1:<port>/spike/` — Spotify no longer
accepts `localhost` as a Redirect URI at all (see the Sept 2026 docs
notes below), even if your dev server's own default is `localhost`.

You'll also need a **track URI** to test with: in the Spotify app, open a
track's "…" menu → Share → Copy Song Link, and paste the resulting
`open.spotify.com/track/...` link straight into the "Track URI to test"
field — the page converts it for you. It doesn't matter which song.

## How to test (three scenarios)

### 1. Normal browser tab

1. Open `.../spike/` in the tablet's regular browser.
2. Tap **Log in with Spotify**, sign in, approve access.
3. You should land back on the page with your account name shown and
   **Device ID** filled in within a few seconds.
4. Paste/confirm a track URI, tap the big **▶ Play** button.
5. **Pass:** audio starts playing through the tablet within a couple of
   seconds of the tap, and the event log shows `ready` → (tap) →
   `activate_element` → `play_request` → `player_state_changed` with
   `"paused":false`.

### 2. Installed as a home-screen web app

1. From the same browser, add the page to the home screen (iOS Safari:
   Share → Add to Home Screen; Android Chrome: menu → Add to Home screen /
   Install app).
2. Close the browser entirely, then launch the app from the home-screen
   icon (not from the browser).
3. Repeat the login (first launch) and play steps above.
4. **Pass:** same as scenario 1 — playback starts from a tap with no
   browser address bar visible.
5. **Also note, whichever way it goes (both are fine, we just need to
   know):** when you tap "Log in with Spotify" from the home-screen icon,
   does it return you to the same standalone app window afterward, or does
   it drop you into the regular browser? This matters for the real app's
   "no way to wander off" goal — if login kicks a kid-facing kiosk out to
   a full browser, that's worth knowing now.

### 3. After locking and unlocking the screen

1. With the spike open (either as a browser tab or the installed app) and
   a song already playing, lock the tablet's screen for at least 30
   seconds, then unlock it.
2. **Pass:** playback either kept playing through the lock, or stopped but
   the page is still logged in and a tap on **▶ Play** resumes it without
   needing to log in again.
3. **Fail signal to watch for:** the page reloaded from scratch (you're
   back at the login screen), or the Device ID reverts to "not ready" and
   never recovers without a manual page reload. Either is useful
   information, not just a pass/fail — copy the log either way (see
   below).
4. Repeat once more, but lock the screen for several minutes (long enough
   for the OS to more aggressively suspend background tabs) — some mobile
   browsers behave differently for a 30-second lock vs. a multi-minute one.

## What to watch for in the event log

Every SDK event and every error is timestamped on screen as it happens —
no devtools needed. A few, if you see them, already have a plain-language
hint attached in the log entry itself:

| Event | What it usually means |
|---|---|
| `ready` | SDK connected; `device_id` is now usable. This is the one that must fire for any of this to work. |
| `not_ready` | Connection dropped (common right after a lock/unlock — see scenario 3). |
| `autoplay_failed` | Browser blocked audio from that tap. |
| `account_error` | Either the Premium requirement isn't met, or (Development Mode) this Spotify account isn't on the app's allowed-users list yet. |
| `authentication_error` | Access token was rejected — try Log out, then log back in. |
| `initialization_error` | The SDK itself couldn't start in this browser. |
| `playback_error` | The specific play request failed. |

## What to send back

For each of the three scenarios above: pass/fail, plus tap **Copy** in the
event log panel and paste the result back (it copies the full log,
timestamps included — no need to screenshot or transcribe). If something
looks wrong, the log almost always shows why.

## Context from checking the current Spotify docs (Sept 2026)

Before writing any of this, I checked the current state of Spotify's Web
API and Web Playback SDK against the official docs, since the brief
flagged that Development Mode changed in Feb–Mar 2026 and my training data
predates that. Direct access to developer.spotify.com was blocked by this
environment's network policy, so this is triangulated from Spotify's own
changelog/blog content as quoted in several independent secondary sources
(GitHub issues citing the docs verbatim, and the Spotify community forum's
official migration announcement thread) rather than the docs pages
directly — worth a skim of the dashboard's own notices when you set up the
app, in case anything shifted again since. Findings relevant to this spike
and the rest of the project:

- **Player control endpoints are unaffected.** `/me/player/play`,
  `pause`, `next`, `previous`, `volume`, etc. remain available in
  Development Mode — confirmed by multiple sources, none of which listed
  playback endpoints among the removals. What *was* removed in the
  migration: browse endpoints, artist top tracks, other users'
  profiles/playlists, `available_markets`, batch-fetch endpoints; per-item
  library save/follow endpoints were consolidated into single `PUT`/`DELETE
  /me/library` calls. None of that touches this spike or the playback
  parts of Phase 1.
- **The Web Playback SDK itself (sdk.scdn.co) appears unchanged** — the
  migration was entirely about Web API REST endpoints, and nothing
  suggests the SDK's event names or `Spotify.Player` methods changed. The
  events this spike listens for (`ready`, `not_ready`,
  `initialization_error`, `authentication_error`, `account_error`,
  `playback_error`, `autoplay_failed`, `player_state_changed`) match what
  the SDK reference still describes.
- **New Development Mode apps (which yours will be, created now) are
  capped at 1 Client ID per developer and a small number of allowed
  users, and require the app owner to have active Premium.** None of this
  is a practical constraint for a single-family app with one user, but it
  does mean: make sure the Spotify account you log in with on the tablet
  either *is* the app owner's account, or has been explicitly added to the
  app's user list in the dashboard — otherwise expect `account_error`.
- **Refresh tokens now expire 6 months after the original login**, for new
  apps effective immediately (existing apps were phased in from July
  2026). This doesn't affect Phase 0 testing directly (6 months won't
  elapse during this test), but it's why `auth.js` treats a refresh
  failure (`invalid_grant`) as "please log in again" rather than retrying
  — that path is already implemented, not deferred to Phase 1.
- **Redirect URIs can no longer use `localhost`** — only exact loopback IP
  literals (`http://127.0.0.1:<port>/`) or HTTPS. This spike's
  `redirectUri` is computed from `window.location.origin +
  window.location.pathname` specifically so the same code works on both
  GitHub Pages and a registered `127.0.0.1` dev URL without hardcoding
  either.
- **Two fields worth flagging for Phase 1, not blocking for this spike:**
  the user object's `product` field (the old way to check "is this account
  Premium?") may no longer be returned — the parent-mode Premium-lapsed
  warning the brief asks for should key off a `403` from the playback
  endpoints instead, which this spike's error handling already treats as
  the authoritative signal rather than checking `/me` fields. Separately,
  the `email` field on `/me` may also be absent even though the
  `user-read-email` scope still exists to request it — worth not
  hard-depending on it being present when the account panel gets built.
- **Search endpoint limit dropped from 50 to 10 per request** — doesn't
  affect this spike (no search here), but Phase 1's parent-mode search
  will need offset-based "load more" pagination for this reason, as the
  brief already anticipated.

## If the SDK doesn't work out

Don't spend extra time debugging exotic edge cases on the SDK path — if
scenario 1 or 2 fails outright (not just the lock/unlock edge case in
scenario 3), that's the signal to switch to the Spotify Connect
remote-control fallback instead of pushing further on the Web Playback
SDK. Send back what you saw and we'll switch `player.js` to that
implementation — the rest of the app (auth, UI, tile grid) doesn't change.
