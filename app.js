import { createYouTubePlayer } from './youtube-player.js';
import { fetchVideoMetadata } from './youtube-api.js';
import { loadStore, saveStore, seedFamilyIfNeeded, getActiveKid, addKid, removeKid, decodeShareLinkHash, tileFromTrack } from './store.js';
import { createKidMode } from './kid-mode.js';
import { createParentGate } from './parent-gate.js';
import { createParentMode } from './parent-mode.js';
import { alertDialog } from './dialog.js';

const views = {
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

function getActiveKidConfig() {
  return getActiveKid(store);
}

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
    volumeValue: document.getElementById('volume-value'),
    tileCount: document.getElementById('tile-count'),
    tileCountWarning: document.getElementById('tile-count-warning'),
    tileRemoveStatus: document.getElementById('tile-remove-status'),
    tileList: document.getElementById('tile-list'),
    colorPickerInput: document.getElementById('color-picker-input'),
    addLinksInput: document.getElementById('add-links-input'),
    addLinksBtn: document.getElementById('add-links-btn'),
    addLinksError: document.getElementById('add-links-error'),
    addLinksResults: document.getElementById('add-links-results'),
    addAllBtn: document.getElementById('add-all-btn'),
    tileDisplayRadios: Array.from(document.querySelectorAll('input[name="tile-display"]')),
    endOfSongRadios: Array.from(document.querySelectorAll('input[name="end-of-song"]')),
    visualizerModeRadios: Array.from(document.querySelectorAll('input[name="visualizer-mode"]')),
    volumeSlider: document.getElementById('volume-slider'),
    sleepTimerSelect: document.getElementById('sleep-timer-select'),
    hideExplicitToggle: document.getElementById('hide-explicit-toggle'),
    songLockToggle: document.getElementById('song-lock-toggle'),
    changePinBtn: document.getElementById('change-pin-btn'),
    signedInSessionStatus: document.getElementById('signed-in-session-status'),
    signedInSessionBtn: document.getElementById('signed-in-session-btn'),
    saveBtn: document.getElementById('save-btn'),
    exportBtn: document.getElementById('export-btn'),
    importBtn: document.getElementById('import-btn'),
    importFileInput: document.getElementById('import-file-input'),
    copyLinkBtn: document.getElementById('copy-link-btn'),
    saveStatus: document.getElementById('save-status'),
    doneBtn: document.getElementById('parent-done-btn'),
    doneBtnBottom: document.getElementById('parent-done-btn-bottom'),
  },
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
  getUseSignedInSession: () => store.useSignedInYouTubeSession,
  onToggleSignedInSession(next) {
    store = { ...store, useSignedInYouTubeSession: next };
    saveStore(store);
    // The player's embed domain is fixed at construction time (it's a
    // YT.Player constructor option, not something changeable on a live
    // iframe) — a full reload is the honest way to actually apply this,
    // rather than leaving the toggle showing a state playback doesn't
    // match yet until the next natural page load.
    window.location.reload();
  },
  onDone: async () => {
    if (getActiveKidConfig().tiles.length < 1) {
      await alertDialog('Add at least one song before returning to kid mode.');
      return;
    }
    showOnly('kid');
    kidMode.show();
  },
});

function refreshParentMode() {
  parentMode.show();
}

function enterParentMode() {
  showOnly('parent');
  parentMode.show();
}

// A setup link (see store.js's encodeShareLink/decodeShareLinkHash)
// carries youtube:video:<id> uris plus any per-tile emoji/color
// overrides — this re-fetches each one's real title/thumbnail rather
// than trusting whatever the link's own compact payload happened to
// snapshot, the same way the Spotify version re-fetched by id instead of
// trusting a possibly-stale name/art baked into the link. A track that
// fails to look up (deleted video, network hiccup) still becomes a tile
// — with just its uri and any override — rather than silently dropping
// the song a parent explicitly shared.
async function applyPendingShareLink() {
  const compact = window.__pendingShareLink;
  if (!compact) return;
  window.__pendingShareLink = null;
  try {
    const tiles = await Promise.all(
      compact.uris.map(async (uri, i) => {
        const override = compact.overrides && compact.overrides[i];
        try {
          const track = await fetchVideoMetadata(uri);
          return tileFromTrack(track, override ? { override } : {});
        } catch (e) {
          return { id: 'imported_' + i, uri, title: '', artist: '', albumArtUrl: null, durationMs: 0, explicit: false, override: override || null };
        }
      })
    );
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

async function initPlayerAndKidMode() {
  player = createYouTubePlayer({
    volume: getActiveKidConfig().settings.maxVolume,
    useSignedInSession: store.useSignedInYouTubeSession,
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

  await applyPendingShareLink();
  window.history.replaceState({}, document.title, window.location.pathname);

  await initPlayerAndKidMode();

  if (getActiveKidConfig().tiles.length < 1) {
    enterParentMode();
  } else {
    showOnly('kid');
    kidMode.show();
  }
}

main();
