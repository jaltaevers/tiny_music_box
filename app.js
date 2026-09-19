import { SPOTIFY_CONFIG } from './config.js';
import * as auth from './auth.js';
import { createSpotifyApi } from './spotify-api.js';
import { createPlayer } from './player.js';
import { loadStore, saveStore, seedFamilyIfNeeded, getActiveKid, addKid, removeKid, decodeShareLinkHash, tileFromTrack } from './store.js';
import { createKidMode } from './kid-mode.js';
import { createParentGate } from './parent-gate.js';
import { createParentMode } from './parent-mode.js';
import { alertDialog, promptDialog } from './dialog.js';

const views = {
  login: document.getElementById('login-view'),
  kid: document.getElementById('kid-mode'),
  gate: document.getElementById('parent-gate-view'),
  parent: document.getElementById('parent-mode-view'),
};

function showOnly(name) {
  for (const key of Object.keys(views)) {
    views[key].hidden = key !== name;
  }
}

// `store` holds every kid's tiles/settings plus the one PIN shared by the
// whole device. `getActiveKidConfig` is the single place that resolves
// "whichever kid is current" — kid mode, parent mode's editor, and the
// title bar all read through it so they can never disagree about who's up.
let store = seedFamilyIfNeeded(loadStore());
saveStore(store);
let lastSpotifyProfile = null;

function getActiveKidConfig() {
  return getActiveKid(store);
}

const api = createSpotifyApi(SPOTIFY_CONFIG, { onReauthRequired: forceReauth });

function forceReauth() {
  auth.clearTokens();
  showOnly('login');
}

document.getElementById('login-btn').addEventListener('click', () => {
  auth.redirectToLogin(SPOTIFY_CONFIG).catch((e) => {
    const el = document.getElementById('login-error');
    el.hidden = false;
    el.textContent = e.message;
  });
});

// Spotify rejects the whole login attempt (its own error page, before ever
// redirecting back here) when redirect_uri doesn't exactly match a URI
// registered in the app dashboard. This app can't fix that registration —
// only the dashboard can — so instead it surfaces the exact value it's
// sending and flags a way this page can end up computing one that could
// never work, so a parent debugging "login is broken" from this screen
// isn't stuck guessing. (The other known-bad case, opening this page via
// file://, is handled by the inline script in index.html instead — this
// module script never even loads under file://, so it can't detect it.)
function describeRedirectUriProblem() {
  if (window.location.hostname === 'localhost') {
    return 'Spotify no longer accepts "localhost" as a Redirect URI. Use the same server at http://127.0.0.1:<port>/ instead (same page, different address in the bar), and register that exact address.';
  }
  return null;
}

(function initRedirectUriHelp() {
  document.getElementById('redirect-uri-value').textContent = SPOTIFY_CONFIG.redirectUri;

  const problem = describeRedirectUriProblem();
  if (problem) {
    const warningEl = document.getElementById('redirect-uri-warning');
    warningEl.hidden = false;
    warningEl.textContent = problem;
  }

  document.getElementById('copy-redirect-uri-btn').addEventListener('click', async () => {
    const statusEl = document.getElementById('redirect-uri-status');
    try {
      await navigator.clipboard.writeText(SPOTIFY_CONFIG.redirectUri);
      statusEl.textContent = 'Copied.';
    } catch (e) {
      await promptDialog('Copy this address:', SPOTIFY_CONFIG.redirectUri, { title: 'Copy address', confirmLabel: 'Close', cancelLabel: '' });
    }
    setTimeout(() => (statusEl.textContent = ''), 2500);
  });
})();

let player = null;
let kidMode = null;

const parentGate = createParentGate({
  els: {
    title: document.getElementById('parent-gate-title'),
    message: document.getElementById('parent-gate-message'),
    input: document.getElementById('parent-gate-input'),
    error: document.getElementById('parent-gate-error'),
    form: document.getElementById('parent-gate-form'),
    cancelBtn: document.getElementById('parent-gate-cancel-btn'),
  },
  // The PIN gates parent mode itself, before any kid is picked, so it
  // lives on the store directly rather than inside a kid's settings —
  // this shim is the only place that needs to know that.
  getConfig: () => ({ settings: { pinHash: store.pinHash } }),
  saveSettings(partial) {
    if (partial.pinHash !== undefined) {
      store = { ...store, pinHash: partial.pinHash };
      saveStore(store);
    }
  },
  onSuccess: () => enterParentMode(),
  onCancel: () => showOnly('kid'),
});

const parentMode = createParentMode({
  els: {
    kidTabs: document.getElementById('kid-tabs'),
    addKidBtn: document.getElementById('add-kid-btn'),
    kidNameInput: document.getElementById('kid-name-input'),
    quickPlaylistInput: document.getElementById('quick-playlist-input'),
    quickPlaylistBtn: document.getElementById('quick-playlist-btn'),
    quickPlaylistStatus: document.getElementById('quick-playlist-status'),
    quickPlaylistError: document.getElementById('quick-playlist-error'),
    quickPlaylistOpenRow: document.getElementById('quick-playlist-open-row'),
    quickPlaylistOpenLink: document.getElementById('quick-playlist-open-link'),
    volumeValue: document.getElementById('volume-value'),
    accountInfo: document.getElementById('account-info'),
    scopeInfo: document.getElementById('scope-info'),
    scopeDetails: document.getElementById('scope-details'),
    tokenWarning: document.getElementById('token-warning'),
    scopeWarning: document.getElementById('scope-warning'),
    tileCount: document.getElementById('tile-count'),
    tileCountWarning: document.getElementById('tile-count-warning'),
    tileRemoveStatus: document.getElementById('tile-remove-status'),
    tileList: document.getElementById('tile-list'),
    colorPickerInput: document.getElementById('color-picker-input'),
    searchResults: document.getElementById('search-results'),
    searchLoadMore: document.getElementById('search-load-more'),
    searchInput: document.getElementById('search-input'),
    playlistInput: document.getElementById('playlist-input'),
    playlistFetchBtn: document.getElementById('playlist-fetch-btn'),
    playlistError: document.getElementById('playlist-error'),
    playlistResults: document.getElementById('playlist-results'),
    playlistAddAllBtn: document.getElementById('playlist-add-all-btn'),
    tabSearchBtn: document.getElementById('tab-search'),
    tabPlaylistBtn: document.getElementById('tab-playlist'),
    searchPanel: document.getElementById('search-panel'),
    playlistPanel: document.getElementById('playlist-panel'),
    tileDisplayRadios: Array.from(document.querySelectorAll('input[name="tile-display"]')),
    endOfSongRadios: Array.from(document.querySelectorAll('input[name="end-of-song"]')),
    visualizerModeRadios: Array.from(document.querySelectorAll('input[name="visualizer-mode"]')),
    volumeSlider: document.getElementById('volume-slider'),
    sleepTimerSelect: document.getElementById('sleep-timer-select'),
    hideExplicitToggle: document.getElementById('hide-explicit-toggle'),
    songLockToggle: document.getElementById('song-lock-toggle'),
    changePinBtn: document.getElementById('change-pin-btn'),
    saveBtn: document.getElementById('save-btn'),
    exportBtn: document.getElementById('export-btn'),
    importBtn: document.getElementById('import-btn'),
    importFileInput: document.getElementById('import-file-input'),
    copyLinkBtn: document.getElementById('copy-link-btn'),
    saveStatus: document.getElementById('save-status'),
    doneBtn: document.getElementById('parent-done-btn'),
    doneBtnBottom: document.getElementById('parent-done-btn-bottom'),
    logoutBtn: document.getElementById('logout-btn'),
    reloginBtn: document.getElementById('relogin-btn'),
  },
  api,
  getSavedConfig: getActiveKidConfig,
  saveAndApply(newKidConfig) {
    store = { ...store, kids: store.kids.map((k) => (k.id === newKidConfig.id ? newKidConfig : k)) };
    saveStore(store);
    // Otherwise a new max volume only ever reaches the player on the next
    // tile tap — a song already playing when a parent saves stays at
    // whatever volume it started at, which reads as the slider doing
    // nothing if that's the song they were adjusting it for.
    if (player) player.setVolume(newKidConfig.settings.maxVolume).catch((e) => console.error('Failed to apply max volume on save', e));
    if (kidMode) kidMode.show();
  },
  getKids: () => store.kids,
  getActiveKidId: () => store.activeKidId,
  onSwitchKid(kidId) {
    store = { ...store, activeKidId: kidId };
    saveStore(store);
    refreshParentMode();
  },
  onAddKid(name) {
    store = addKid(store, name);
    saveStore(store);
    refreshParentMode();
  },
  onRemoveKid(kidId) {
    store = removeKid(store, kidId);
    saveStore(store);
    refreshParentMode();
    if (kidMode) kidMode.show();
  },
  onChangePin(pinHash) {
    store = { ...store, pinHash };
    saveStore(store);
  },
  onDone: async () => {
    if (getActiveKidConfig().tiles.length < 1) {
      await alertDialog('Add at least one song before returning to kid mode.');
      return;
    }
    showOnly('kid');
    kidMode.show();
  },
  onLogout: () => {
    auth.clearTokens();
    window.location.reload();
  },
  onRelogin: () => {
    auth.redirectToLogin(SPOTIFY_CONFIG).catch((e) => alertDialog(e.message));
  },
  onReauthRequired: forceReauth,
});

function refreshParentMode() {
  parentMode.show(lastSpotifyProfile);
}

function enterParentMode() {
  showOnly('parent');
  // Shows the editor immediately with whatever profile is already cached
  // (or none yet) rather than waiting on this fetch — every settings/
  // search control's listener is bound once at startup and assumes the
  // draft it edits already exists the moment this view is interactive, so
  // that draft can't be left waiting on a network round-trip. The Account
  // panel is the only part that actually needs the fetched profile, and
  // setAccountProfile() below fills it in on its own once the fetch
  // resolves, without re-running show() and discarding an in-progress edit.
  parentMode.show(lastSpotifyProfile);
  api
    .getMe()
    .then((profile) => {
      lastSpotifyProfile = profile;
      parentMode.setAccountProfile(profile);
    })
    .catch(() => {
      lastSpotifyProfile = null;
      parentMode.setAccountProfile(null);
    });
}

async function applyPendingShareLink() {
  const compact = window.__pendingShareLink;
  if (!compact) return;
  window.__pendingShareLink = null;
  try {
    const ids = compact.uris.map((uri) => uri.split(':')[2]);
    const tracks = await api.getTracksByIds(ids);
    const tiles = compact.uris.map((uri, i) => {
      const track = tracks[i];
      const override = compact.overrides && compact.overrides[i];
      if (!track) return { id: 'imported_' + i, uri, title: '', artist: '', albumArtUrl: null, durationMs: 0, explicit: false, override: override || null };
      return tileFromTrack(track, override ? { override } : {});
    });
    store = {
      ...store,
      kids: store.kids.map((k) =>
        k.id === store.activeKidId
          ? { ...k, tiles, sourcePlaylistUrl: compact.sourcePlaylistUrl || k.sourcePlaylistUrl, settings: { ...k.settings, ...(compact.settings || {}) } }
          : k
      ),
    };
    saveStore(store);
  } catch (e) {
    console.error('Failed to import setup link', e);
  }
}

// Runs once per login, in the background: any kid with a playlist link
// attached but no songs yet (freshly seeded by seedFamilyIfNeeded, or a
// kid a parent added and pointed at a playlist without loading it) gets
// that playlist pulled in automatically, so opening the app after logging
// in is the only step actually needed — this is also the only place that
// *can* do it, since it's the first point after login with a real API
// token to fetch with. Never awaited by its caller: it must not delay
// showing kid mode or parent mode, and a kid whose fetch fails (offline,
// playlist not accessible, etc.) is no worse off than before — the same
// playlist link is still sitting in their Quick Setup box to retry by hand.
async function autoFetchMissingPlaylists() {
  const pending = store.kids.filter((k) => k.sourcePlaylistUrl && k.tiles.length === 0);
  for (const kid of pending) {
    try {
      const tracks = await api.getPlaylistItems(kid.sourcePlaylistUrl);
      const eligible = tracks.filter((t) => !(kid.settings.hideExplicit && t.explicit));
      if (eligible.length === 0) continue;
      const tiles = eligible.map((t) => tileFromTrack(t));
      store = { ...store, kids: store.kids.map((k) => (k.id === kid.id ? { ...k, tiles } : k)) };
      saveStore(store);
    } catch (e) {
      console.error(`Auto-fetch failed for kid "${kid.settings.kidName}"`, e);
    }
  }
  // A kid starting with 0 tiles is never the one main() already routed
  // into kid mode for, so the only view that can be showing stale data
  // once this finishes is parent mode's kid-tab bar and editor.
  if (!views.parent.hidden) refreshParentMode();
}

async function initPlayerAndKidMode() {
  player = createPlayer({
    name: 'Kids Music Tiles',
    volume: getActiveKidConfig().settings.maxVolume,
    api,
    getOAuthToken: (callback) => {
      auth
        .getValidAccessToken(SPOTIFY_CONFIG)
        .then((token) => {
          if (token) callback(token);
        })
        .catch(() => {});
    },
  });

  kidMode = createKidMode({
    els: {
      grid: document.getElementById('kid-grid'),
      bgVisualizerCanvas: document.getElementById('kid-bg-visualizer'),
      overlay: document.getElementById('now-playing-overlay'),
      npArt: document.getElementById('np-art'),
      progressBar: document.getElementById('np-progress-bar'),
      error: document.getElementById('kid-error'),
      errorDetail: document.getElementById('kid-error-detail'),
      parentGateBtn: document.getElementById('parent-gate-btn'),
      backBtn: document.getElementById('back-to-tiles-btn'),
      playPause: document.getElementById('np-play-pause'),
      greeting: document.getElementById('kid-greeting'),
      sparkleLayer: document.getElementById('sparkle-layer'),
      visualizerCanvas: document.getElementById('np-visualizer'),
      vizToggleBtn: document.getElementById('np-viz-toggle'),
      lockToast: document.getElementById('kid-lock-toast'),
      npTitle: document.getElementById('np-title'),
    },
    player,
    getConfig: getActiveKidConfig,
    onOpenParentGate: () => {
      showOnly('gate');
      parentGate.show();
    },
    onToggleVisualizer: (mode) => {
      const activeId = store.activeKidId;
      store = { ...store, kids: store.kids.map((k) => (k.id === activeId ? { ...k, settings: { ...k.settings, visualizerMode: mode } } : k)) };
      saveStore(store);
    },
  });

  try {
    await player.init();
  } catch (e) {
    console.error('Player init failed', e);
  }
}

async function main() {
  const pendingHash = window.location.hash;
  if (pendingHash) {
    try {
      window.__pendingShareLink = decodeShareLinkHash(pendingHash);
    } catch (e) {
      await alertDialog('That setup link looks invalid: ' + e.message);
    }
  }

  try {
    await auth.handleRedirectCallback(SPOTIFY_CONFIG);
  } catch (e) {
    const el = document.getElementById('login-error');
    el.hidden = false;
    el.textContent = e.message;
  }

  if (!auth.loadTokens()) {
    showOnly('login');
    return;
  }

  await applyPendingShareLink();
  window.history.replaceState({}, document.title, window.location.pathname);

  await initPlayerAndKidMode();
  autoFetchMissingPlaylists(); // fire-and-forget — see its own comment

  if (getActiveKidConfig().tiles.length < 1) {
    enterParentMode();
  } else {
    showOnly('kid');
    kidMode.show();
  }
}

main();
