// Wiring for youtube-player-demo.html. Deliberately independent of
// store.js/app.js — this proves youtube-player.js (and youtube-api.js)
// work entirely on their own, with no dependency on the rest of the app.
import { createYouTubePlayer, extractVideoId } from './youtube-player.js';
import { fetchVideoMetadata } from './youtube-api.js';

const els = {
  input: document.getElementById('demo-video-input'),
  loadBtn: document.getElementById('demo-load-btn'),
  error: document.getElementById('demo-error'),
  ready: document.getElementById('demo-ready'),
  title: document.getElementById('np-title'),
  adNotice: document.getElementById('np-ad-notice'),
  progressBar: document.getElementById('np-progress-bar'),
  playPause: document.getElementById('np-play-pause'),
  previousBtn: document.getElementById('np-previous'),
  nextBtn: document.getElementById('np-next'),
  volumeSlider: document.getElementById('demo-volume-slider'),
  volumeValue: document.getElementById('demo-volume-value'),
  log: document.getElementById('demo-log'),
};

// A well-known, stable, publicly embeddable video, prefilled purely for
// convenience so there's something to click immediately — YouTube's own
// first-ever upload, "Me at the zoo" (confirmed reachable at the time
// this was written). Delete it and paste your own; the field accepts any
// mix of full YouTube URLs and bare video IDs, one per line.
els.input.value = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

function log(message) {
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}

function showError(message) {
  els.error.hidden = false;
  els.error.textContent = message;
}
function hideError() {
  els.error.hidden = true;
}

const player = createYouTubePlayer({ volume: Number(els.volumeSlider.value) / 100 });
// Exposed for poking at from the devtools console — e.g.
// __ytPlayerDemo.getState().then(console.log) — since this page's whole
// purpose is letting you inspect the engine directly, unlike the real
// kids' app where nothing does this.
window.__ytPlayerDemo = player;

// Mirrors kid-mode.js's own progress-bar ticker exactly: onStateChange
// fires only on discrete changes (play/pause/track change/ad flip), not
// continuously, so a local interval extrapolates position between them
// from a position+timestamp anchor rather than needing a stream of ticks
// from the player itself.
let lastState = { position: 0, durationMs: 0, updatedAt: 0, paused: true };
let tickHandle = null;

function startTicker() {
  stopTicker();
  tickHandle = setInterval(() => {
    if (lastState.paused || !lastState.durationMs) return;
    const elapsed = lastState.position + (Date.now() - lastState.updatedAt);
    els.progressBar.style.width = Math.min(100, (elapsed / lastState.durationMs) * 100) + '%';
  }, 250);
}
function stopTicker() {
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = null;
}
startTicker();

player.onStateChange((state) => {
  if (!state) return;
  const track = state.track_window && state.track_window.current_track;
  lastState = {
    position: state.position,
    durationMs: track ? track.duration_ms : 0,
    updatedAt: Date.now(),
    paused: state.paused,
  };
  els.playPause.textContent = state.paused ? '▶' : '⏸';
  els.adNotice.hidden = !state.isLikelyAd;
});

let currentQueueItems = [];

player.onEvent(({ type, data }) => {
  const suffix = data && Object.keys(data).length ? ' ' + JSON.stringify(data) : '';
  log(`${type}${suffix}`);
  if (type === 'track_changed') {
    const item = currentQueueItems[data.index];
    els.title.textContent = (item && item.title) || data.uri;
  }
  if (type === 'playback_error') showError(data.message || 'Playback error');
  if (type === 'ad_suspected') log('⚠ heuristic guess only — see youtube-player.js’s "Ad detection" comments');
  if (type === 'muted_autoplay_started') showError('Browser started this muted — tap ▶ once to ask for sound.');
});

async function parseQueue() {
  const lines = els.input.value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const items = [];
  for (const line of lines) {
    const videoId = extractVideoId(line);
    if (!videoId) throw new Error(`Not a recognizable YouTube URL or video ID: "${line}"`);
    // Real title/artist/artwork, via oEmbed (see youtube-api.js) — feeds
    // Media Session metadata (lock-screen/notification controls), same
    // as the real app now does. Best-effort: a lookup failure still
    // queues the video with a bare uri rather than blocking playback.
    let meta = { title: null, artist: null, artworkUrl: null };
    try {
      const track = await fetchVideoMetadata(videoId);
      meta = { title: track.title, artist: track.channelTitle, artworkUrl: track.thumbnailUrl };
    } catch (e) {
      log(`Metadata lookup failed for ${videoId} (queueing anyway): ${e.message}`);
    }
    items.push({ uri: `youtube:video:${videoId}`, durationMs: null, ...meta });
  }
  if (items.length === 0) throw new Error('Paste at least one YouTube URL or video ID.');
  return items;
}

async function loadFromInput() {
  hideError();
  els.title.textContent = 'Looking up…';
  try {
    // activateElement() first, before parseQueue()'s real network awaits
    // (the oEmbed lookups) — it needs to run as close to this tap's own
    // gesture as possible; the real app never has this ordering question
    // since its tiles already carry looked-up metadata well before any
    // tap (see kid-mode.js), this demo just cannot know a link's title
    // until you tell it which link.
    await player.activateElement();
    const items = await parseQueue();
    currentQueueItems = items;
    await player.playTracks(items, 0);
  } catch (e) {
    els.title.textContent = 'Nothing loaded yet';
    showError(e.message);
  }
}

els.loadBtn.addEventListener('click', loadFromInput);
els.playPause.addEventListener('click', () => {
  (lastState.paused ? player.resume() : player.pause()).catch((e) => showError(e.message));
});
els.previousBtn.addEventListener('click', () => player.previous().catch((e) => showError(e.message)));
els.nextBtn.addEventListener('click', () => player.next().catch((e) => showError(e.message)));
els.volumeSlider.addEventListener('input', () => {
  const percent = Number(els.volumeSlider.value);
  els.volumeValue.textContent = String(percent);
  player.setVolume(percent / 100);
});

player
  .init()
  .then(() => {
    els.ready.textContent = 'Player ready — tap "Load queue & play".';
    log('Player ready.');
  })
  .catch((e) => {
    els.ready.textContent = '';
    showError(e.message);
  });
