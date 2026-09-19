// Thin wrapper around the YouTube IFrame Player API, kept behind the same
// small interface player.js (the Spotify Web Playback SDK version) already
// exposed: init, playTracks, pause, resume, next, previous, setVolume,
// getState, setRepeatMode, onStateChange, onEvent, activateElement (+
// getDeviceId, kept only so nothing calling it throws). Everything that
// consumes a player through that interface — kid-mode.js in particular —
// needs no changes to run on this instead of player.js.
//
// Two things Spotify's Connect-based playback got "for free" from
// Spotify's own backend have to be reimplemented here, since a single
// YT.Player only ever loads one video at a time:
//   - a queue with a current index, so playTracks(list, offset) + auto-
//     advance-on-end can still queue a kid's whole tile grid at once
//   - repeat mode ('off' | 'track' | 'context'), as pure local state
//
// See the CSS this pairs with (search style.css for ".yt-hidden-player")
// for why the iframe is hidden with opacity/position rather than
// display:none — that part matters for playback to keep working at all,
// not just for layout.

const IFRAME_API_URL = 'https://www.youtube.com/iframe_api';
// A restrictive network (a filtered school/kid tablet, a corporate proxy,
// an ad-blocker) can drop the request for iframe_api without ever firing
// the <script> tag's own onerror — it just never calls back. Without a
// timeout, init() would then hang forever with no feedback. Confirmed
// this matters, not just a hypothetical: this environment's own network
// policy blocks youtube.com outright while this was being built.
const IFRAME_API_LOAD_TIMEOUT_MS = 15_000;

let apiLoadPromise = null;
function loadIframeApi() {
  if (apiLoadPromise) return apiLoadPromise;
  apiLoadPromise = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) {
      resolve(window.YT);
      return;
    }
    const timeoutHandle = setTimeout(() => {
      apiLoadPromise = null; // let a later init() retry instead of replaying this same rejection forever
      reject(new Error('Timed out loading the YouTube IFrame Player API — check network access to youtube.com.'));
    }, IFRAME_API_LOAD_TIMEOUT_MS);
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timeoutHandle);
      resolve(window.YT);
    };
    const script = document.createElement('script');
    script.src = IFRAME_API_URL;
    script.async = true;
    script.onerror = () => {
      clearTimeout(timeoutHandle);
      apiLoadPromise = null;
      reject(new Error('Failed to load the YouTube IFrame Player API script'));
    };
    document.head.appendChild(script);
  });
  return apiLoadPromise;
}

// Stable, long-documented onError codes. 150 is 101 under a different
// number (both mean "owner disabled playback in embedded players").
const ERROR_MESSAGES = {
  2: 'Invalid video ID or parameter',
  5: 'This video cannot be played in the HTML5 player',
  100: 'Video not found — it may have been removed or made private',
  101: 'The video owner has disabled playback in embedded players',
  150: 'The video owner has disabled playback in embedded players',
};

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_URI_RE = /^youtube:video:([A-Za-z0-9_-]{11})$/;

/**
 * Accepts a bare 11-char video ID, a youtube:video:<id> uri (the scheme
 * store.js will mint once tile data comes from YouTube instead of
 * Spotify), or a full youtube.com/youtu.be URL in any of its common
 * shapes (watch?v=, youtu.be/<id>, /embed/<id>, /shorts/<id>). Returns
 * null rather than throwing on anything it doesn't recognize — every
 * caller here treats "couldn't figure out a video ID" as an ordinary,
 * expected failure (bad paste, bad tile data), not an exceptional one.
 */
export function extractVideoId(input) {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (VIDEO_ID_RE.test(trimmed)) return trimmed;

  const uriMatch = YOUTUBE_URI_RE.exec(trimmed);
  if (uriMatch) return uriMatch[1];

  try {
    const url = new URL(trimmed);
    if (url.hostname === 'youtu.be') {
      const id = url.pathname.slice(1);
      return VIDEO_ID_RE.test(id) ? id : null;
    }
    if (/(^|\.)youtube(-nocookie)?\.com$/.test(url.hostname)) {
      if (url.searchParams.has('v')) {
        const id = url.searchParams.get('v');
        return VIDEO_ID_RE.test(id) ? id : null;
      }
      const pathMatch = /\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})/.exec(url.pathname);
      if (pathMatch) return pathMatch[1];
    }
  } catch (e) {
    // Not a URL at all (e.g. a stray word) — falls through to null below.
  }
  return null;
}

function clampVolume(v) {
  return Math.max(0, Math.min(1, v));
}

// A live duration under this is never trusted as "the song really is this
// short" — below it, maybeFlagAd() simply never runs, so a legitimately
// short nursery-rhyme tile can't be mistaken for an ad cut short.
const AD_MIN_EXPECTED_DURATION_MS = 45_000;
// A live duration under this fraction of the expected one is treated as
// an ad. 0.6 is deliberately generous — real ad breaks are usually well
// under half the length of an actual song, so this comfortably absorbs
// normal metadata imprecision (a duration a parent typed, or fetched at a
// slightly different time) without flagging real content as an ad.
const AD_DURATION_RATIO = 0.6;
// Stop polling a given video for the ad→content transition after this
// long, win or lose — nothing legitimate should still be mid-transition
// this far in, and it keeps a permanently-misbehaving video from polling
// forever.
const AD_WATCH_WINDOW_MS = 45_000;
const AD_POLL_INTERVAL_MS = 1000;

/**
 * @param {Object} [options]
 * @param {HTMLElement|string} [options.mountEl] - Element (or element id)
 *   the IFrame API should replace with its <iframe>. Omit to have this
 *   module create its own hidden container and append it to <body> —
 *   the zero-config path, and what the demo page uses.
 * @param {number} [options.volume=1] - Initial volume, 0..1.
 * @param {boolean} [options.muteDuringSuspectedAds=true] - See the
 *   "Ad detection" section below: whether a suspected ad is played back
 *   muted (ducked to 0) until real content resumes.
 * @param {boolean} [options.useSignedInSession=false] - Embeds from
 *   youtube.com instead of youtube-nocookie.com. YouTube restricts
 *   background/lock-screen playback (this app's biggest real limitation)
 *   to Premium accounts, enforced by YouTube's own player regardless of
 *   embed domain — this does NOT bypass that. The only thing it can do
 *   is give the iframe a *chance* to inherit an already-signed-in
 *   Premium session already present in this browser (the youtube-
 *   nocookie.com domain deliberately avoids that session — that's the
 *   whole point of it). Off by default: it trades away that privacy
 *   property for a fix that isn't guaranteed to do anything even when
 *   the browser IS signed into Premium — see parent-mode.js's UI for
 *   this, which explains the same trade-off to whoever flips it on.
 */
export function createYouTubePlayer({ mountEl, volume = 1, muteDuringSuspectedAds = true, useSignedInSession = false } = {}) {
  let ytPlayer = null;
  let ready = false;
  let pausedFlag = true;
  const stateListeners = new Set();
  const eventListeners = new Set();

  let queue = [];
  let currentIndex = -1;
  let repeatMode = 'off'; // 'off' | 'track' | 'context' — mirrors Spotify's setRepeatMode values
  let configuredVolume = clampVolume(volume);

  let adSuspected = false;
  let adWatchTimer = null;
  let adWatchStartedAt = 0;

  function emitEvent(type, data = {}) {
    for (const listener of eventListeners) {
      try {
        listener({ type, data });
      } catch (e) {
        console.error('event listener threw', e);
      }
    }
  }

  function currentItem() {
    return currentIndex >= 0 && currentIndex < queue.length ? queue[currentIndex] : null;
  }

  function emitState() {
    if (!ytPlayer || !ready) return;
    const item = currentItem();
    const state = {
      paused: pausedFlag,
      position: (ytPlayer.getCurrentTime() || 0) * 1000,
      track_window: {
        current_track: {
          uri: item ? item.uri : null,
          duration_ms: (ytPlayer.getDuration() || 0) * 1000,
        },
      },
      // Not part of the Spotify-shaped contract kid-mode.js reads today —
      // an addition, not a change, so it's safe alongside it. Wire a
      // .isLikelyAd check into kid-mode.js's own onStateChange handler
      // once you're ready to show the "Playing an advertisement" notice
      // there too (the demo page already does, as a working example).
      isLikelyAd: adSuspected,
    };
    for (const listener of stateListeners) {
      try {
        listener(state);
      } catch (e) {
        console.error('state listener threw', e);
      }
    }
  }

  function applyLiveVolume() {
    if (!ytPlayer) return;
    const effective = adSuspected && muteDuringSuspectedAds ? 0 : configuredVolume;
    ytPlayer.setVolume(Math.round(effective * 100));
  }

  // ---------- Ad detection (best-effort — see header note) ----------
  //
  // The IFrame Player API has no documented, supported way to tell "an ad
  // is playing" apart from "the requested content is playing" — no
  // AD_PLAYING state, no onAdStart event, nothing. (Checked against
  // current sources before writing this: developers.google.com itself is
  // blocked by this environment's network policy, same as
  // developer.spotify.com was for SPIKE.md, but independent secondary
  // discussion — including YouTube's own IFrame API issue tracker threads
  // on this exact question — confirms no such event has ever shipped.)
  // What's used instead: sample getDuration() for a while after every
  // load and compare it against the duration the caller told us to
  // expect (durationMs on each playTracks() item). An ad is almost always
  // dramatically shorter than the actual song, so a live duration well
  // under the expected one is a reasonable — not certain — sign an ad is
  // what's currently playing. False negatives (a real ad that this never
  // flags) are the expected failure mode, not false positives: the
  // thresholds below are deliberately conservative about calling
  // something an ad.
  //
  // Also worth knowing: because the iframe is deliberately hidden, a
  // skippable ad's own "Skip Ad" button is invisible and unclickable —
  // there's no way around that while keeping the player hidden, since the
  // page can't reach into a cross-origin iframe's DOM at all. The notice
  // this drives is purely informational ("here's why the song hasn't
  // started"), not a way to skip the ad. Muting during a suspected ad
  // (the default) at least keeps unmoderated ad audio from reaching a
  // kid; it doesn't make the ad end any sooner.
  function clearAdWatch() {
    if (adWatchTimer) clearInterval(adWatchTimer);
    adWatchTimer = null;
  }

  function scheduleAdWatch(item) {
    clearAdWatch();
    if (!item.durationMs || item.durationMs < AD_MIN_EXPECTED_DURATION_MS) return;
    adWatchStartedAt = Date.now();
    adWatchTimer = setInterval(() => {
      if (!ytPlayer || currentItem() !== item) {
        clearAdWatch();
        return;
      }
      if (Date.now() - adWatchStartedAt > AD_WATCH_WINDOW_MS) {
        clearAdWatch();
        return;
      }
      const liveDurationMs = (ytPlayer.getDuration() || 0) * 1000;
      if (!liveDurationMs) return; // metadata not loaded yet — keep waiting

      const looksLikeAd = liveDurationMs / item.durationMs < AD_DURATION_RATIO;
      if (looksLikeAd && !adSuspected) {
        adSuspected = true;
        applyLiveVolume();
        emitEvent('ad_suspected', { expectedDurationMs: item.durationMs, liveDurationMs });
        emitState();
      } else if (!looksLikeAd) {
        if (adSuspected) {
          adSuspected = false;
          applyLiveVolume();
          emitEvent('ad_ended', { liveDurationMs });
          emitState();
        }
        clearAdWatch(); // duration now looks right — nothing left to watch for on this item
      }
    }, AD_POLL_INTERVAL_MS);
  }

  // ---------- Media Session (OS-level now-playing controls) ----------
  //
  // This does NOT override YouTube's own background-playback restriction
  // (confirmed, current policy: background/lock-screen continuation for
  // YouTube video — including third-party iframe embeds — is gated to
  // Premium accounts as an anti-abuse measure, enforced by YouTube's own
  // player/backend, not by generic browser tab-throttling). Nothing
  // client-side can bypass that. What this DOES do: give the browser/OS
  // a real "now playing" session while in the foreground — lock-screen/
  // notification media controls with the right title, artist, and
  // artwork, and (on platforms where the two are handled separately)
  // possibly avoid *additional* generic tab-throttling stacking on top
  // of YouTube's own restriction. A real, worthwhile improvement; not a
  // fix for the thing it sounds like it might fix.
  function hasMediaSession() {
    return typeof navigator !== 'undefined' && 'mediaSession' in navigator;
  }

  function updateMediaSessionMetadata(item) {
    if (!hasMediaSession()) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: item.title || 'Kids Music Tiles',
        artist: item.artist || '',
        artwork: item.artworkUrl ? [{ src: item.artworkUrl, sizes: '512x512', type: 'image/jpeg' }] : [],
      });
    } catch (e) {
      // Cosmetic only (e.g. an unreachable artwork URL can throw in some
      // browsers) — never worth failing playback over.
    }
  }

  function updateMediaSessionPlaybackState() {
    if (!hasMediaSession()) return;
    try {
      navigator.mediaSession.playbackState = pausedFlag ? 'paused' : 'playing';
    } catch (e) {
      // as above
    }
  }

  function setupMediaSessionActionHandlers() {
    if (!hasMediaSession()) return;
    const handlers = {
      play: () => resume().catch(() => {}),
      pause: () => pause().catch(() => {}),
      previoustrack: () => previous().catch(() => {}),
      nexttrack: () => next().catch(() => {}),
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        // Not every action is supported on every browser (previoustrack/
        // nexttrack less universally than play/pause) — setActionHandler
        // throws for an unsupported action rather than ignoring it, so
        // each is registered independently.
        navigator.mediaSession.setActionHandler(action, handler);
      } catch (e) {
        // unsupported action — fine, the rest still register
      }
    }
  }

  // ---------- Queue / transport ----------

  function normalizeItem(entry) {
    if (typeof entry === 'string') {
      const videoId = extractVideoId(entry);
      return { videoId, uri: entry, durationMs: null, title: null, artist: null, artworkUrl: null };
    }
    const videoId = extractVideoId(entry.uri || entry.videoId);
    return {
      videoId,
      uri: entry.uri || (videoId ? `youtube:video:${videoId}` : null),
      durationMs: entry.durationMs || null,
      title: entry.title || null,
      artist: entry.artist || null,
      // store.js's tiles call this albumArtUrl; accept either name so a
      // caller that already has a tile object doesn't need to reshape it.
      artworkUrl: entry.artworkUrl || entry.albumArtUrl || null,
    };
  }

  function loadIndex(index, { isAutoAdvance = false } = {}) {
    const item = queue[index];
    if (!item || !item.videoId) {
      return Promise.reject(new Error(`Queue item at index ${index} isn't a recognizable YouTube video.`));
    }
    currentIndex = index;
    adSuspected = false;
    ytPlayer.loadVideoById(item.videoId);
    applyLiveVolume();
    scheduleAdWatch(item);
    updateMediaSessionMetadata(item);
    emitEvent('track_changed', { index, uri: item.uri, isAutoAdvance });
    return Promise.resolve();
  }

  function handleEnded() {
    if (repeatMode === 'track') {
      loadIndex(currentIndex, { isAutoAdvance: true });
      return;
    }
    if (currentIndex + 1 < queue.length) {
      loadIndex(currentIndex + 1, { isAutoAdvance: true });
    } else if (repeatMode === 'context' && queue.length > 0) {
      loadIndex(0, { isAutoAdvance: true });
    } else {
      emitState(); // queue exhausted, repeat off — stay paused at the end, same as Spotify's context-repeat-off behavior
    }
  }

  function handleYTStateChange(e) {
    const YT = window.YT;
    switch (e.data) {
      case YT.PlayerState.PLAYING:
        pausedFlag = false;
        break;
      case YT.PlayerState.PAUSED:
      case YT.PlayerState.CUED:
        pausedFlag = true;
        break;
      case YT.PlayerState.ENDED:
        pausedFlag = true;
        updateMediaSessionPlaybackState();
        emitEvent('player_state_changed', { code: e.data });
        emitState();
        handleEnded();
        return;
      // BUFFERING and UNSTARTED intentionally leave pausedFlag alone —
      // otherwise ordinary network buffering mid-song would flicker the
      // play/pause icon and momentarily freeze the progress ticker, which
      // reads "paused" as "stop extrapolating position" (see kid-mode.js).
      default:
        break;
    }
    updateMediaSessionPlaybackState();
    emitEvent('player_state_changed', { code: e.data });
    emitState();
  }

  function requireReady() {
    return !!(ready && ytPlayer);
  }

  function playTracks(items, offset = 0) {
    if (!requireReady()) return Promise.reject(new Error('YouTube player not ready yet.'));
    queue = (items || []).map(normalizeItem);
    return loadIndex(offset, { isAutoAdvance: false });
  }

  function pause() {
    if (!requireReady()) return Promise.reject(new Error('YouTube player not ready yet.'));
    ytPlayer.pauseVideo();
    return Promise.resolve();
  }

  function resume() {
    if (!requireReady()) return Promise.reject(new Error('YouTube player not ready yet.'));
    ytPlayer.playVideo();
    return Promise.resolve();
  }

  function next() {
    if (!requireReady()) return Promise.reject(new Error('YouTube player not ready yet.'));
    if (queue.length === 0) return Promise.resolve();
    const hasNext = currentIndex + 1 < queue.length;
    const target = hasNext ? currentIndex + 1 : repeatMode === 'context' ? 0 : currentIndex;
    return loadIndex(target, { isAutoAdvance: false });
  }

  function previous() {
    if (!requireReady()) return Promise.reject(new Error('YouTube player not ready yet.'));
    if (queue.length === 0) return Promise.resolve();
    const hasPrev = currentIndex - 1 >= 0;
    const target = hasPrev ? currentIndex - 1 : repeatMode === 'context' ? queue.length - 1 : currentIndex;
    return loadIndex(target, { isAutoAdvance: false });
  }

  function setVolume(value) {
    configuredVolume = clampVolume(value);
    applyLiveVolume(); // safe even pre-ready: applyLiveVolume() itself no-ops until ytPlayer exists, and onReady applies it once
    return Promise.resolve();
  }

  function setRepeatMode(mode) {
    repeatMode = mode;
    return Promise.resolve();
  }

  async function getState() {
    if (!requireReady()) return null;
    const item = currentItem();
    return {
      paused: pausedFlag,
      position: (ytPlayer.getCurrentTime() || 0) * 1000,
      track_window: { current_track: item ? { uri: item.uri, duration_ms: (ytPlayer.getDuration() || 0) * 1000 } : null },
      isLikelyAd: adSuspected,
    };
  }

  function activateElement() {
    // Must be called synchronously inside the tap handler (before any
    // other await) so the browser still counts what follows as a user
    // gesture — same requirement player.js documents for Spotify's SDK.
    // unMute() here is harmless if already unmuted; it exists to
    // explicitly re-assert, inside that gesture, that whatever plays next
    // is happening with the user's direct say-so — which is what
    // iOS/Chrome's autoplay-with-sound policies key off of.
    if (ytPlayer && ready) {
      try {
        ytPlayer.unMute();
      } catch (e) {
        // Nothing meaningful to do with this — worst case, the browser's
        // own autoplay policy still applies and onAutoplayBlocked/
        // onMutedAutoplayStarts (below) report it.
      }
    }
    return Promise.resolve();
  }

  function getDeviceId() {
    // Vestigial: kept only so code written against player.js's shape
    // (Spotify Connect's device id) doesn't throw calling a missing
    // method. YouTube playback has no device-id concept.
    return null;
  }

  function onStateChange(listener) {
    stateListeners.add(listener);
    return () => stateListeners.delete(listener);
  }
  function onEvent(listener) {
    eventListeners.add(listener);
    return () => eventListeners.delete(listener);
  }

  function createHiddenContainer() {
    const wrapper = document.createElement('div');
    wrapper.className = 'yt-hidden-player';
    // Belt and suspenders with the CSS class above: applied inline too,
    // so this stays hidden even on a page that hasn't loaded style.css
    // (or where the class name collides with something else). See
    // style.css's own ".yt-hidden-player" rule for why these specific
    // properties (not display:none/visibility:hidden) are what keeps
    // playback running while genuinely invisible and untappable.
    Object.assign(wrapper.style, {
      position: 'fixed',
      top: '-1000px',
      left: '-1000px',
      width: '1px',
      height: '1px',
      overflow: 'hidden',
      opacity: '0',
      pointerEvents: 'none',
    });
    const mount = document.createElement('div');
    wrapper.appendChild(mount);
    document.body.appendChild(wrapper);
    return mount;
  }

  function init() {
    // Created up front, before awaiting the (network-dependent) API
    // script load — so the hidden mount point exists in the DOM
    // immediately and predictably on every init() call, rather than only
    // conditionally on the remote script having already loaded.
    const target = mountEl || createHiddenContainer();
    return loadIframeApi().then(
      (YT) =>
        new Promise((resolve, reject) => {
          try {
            ytPlayer = new YT.Player(target, {
              // Privacy-enhanced by default (no third-party cookies until
              // playback starts); useSignedInSession trades that for a
              // chance at inheriting an already-signed-in session instead
              // — see this function's own doc comment for why that's not
              // guaranteed to do anything.
              host: useSignedInSession ? 'https://www.youtube.com' : 'https://www.youtube-nocookie.com',
              width: '1',
              height: '1',
              playerVars: {
                autoplay: 0, // never autoplay on load with no gesture — only ever started via playTracks() from a tap
                controls: 0,
                disablekb: 1,
                fs: 0,
                modestbranding: 1,
                // Critical on iOS: without this, Safari forces the video
                // into native fullscreen playback on play, which would
                // make a "hidden" player suddenly fill the screen the
                // moment a kid taps a tile.
                playsinline: 1,
                rel: 0,
                iv_load_policy: 3, // no video annotations
                origin: window.location.origin,
              },
              events: {
                onReady: () => {
                  ready = true;
                  applyLiveVolume();
                  setupMediaSessionActionHandlers();
                  emitEvent('ready');
                  emitEvent('connect_result', { connected: true });
                  resolve();
                },
                onStateChange: handleYTStateChange,
                onError: (e) => {
                  const message = ERROR_MESSAGES[e.data] || `Unknown player error (code ${e.data})`;
                  const item = currentItem();
                  emitEvent('playback_error', { code: e.data, message, videoId: item ? item.videoId : null });
                },
                // Real, documented events (confirmed current as of this
                // writing) — not the heuristic ad detection above.
                onAutoplayBlocked: () => emitEvent('autoplay_failed'),
                onMutedAutoplayStarts: () => {
                  // The browser allowed autoplay only by silently muting
                  // it — without this, a kid taps a tile, the progress
                  // bar moves, and nothing plays, with no obvious reason
                  // why. unMute() here is best-effort (it can easily be
                  // blocked again by the same policy, since this callback
                  // runs outside the original tap's own call stack) —
                  // emitting the event too lets the UI layer show a "tap
                  // play again for sound" hint if unMute() doesn't stick.
                  try {
                    ytPlayer.unMute();
                  } catch (err) {
                    // best-effort, as above
                  }
                  emitEvent('muted_autoplay_started');
                },
                onMutedAutoplayEnds: () => emitEvent('muted_autoplay_ended'),
              },
            });
          } catch (e) {
            reject(e);
          }
        })
    );
  }

  return {
    init,
    playTracks,
    pause,
    resume,
    next,
    previous,
    setVolume,
    getState,
    setRepeatMode,
    onStateChange,
    onEvent,
    activateElement,
    getDeviceId,
  };
}
