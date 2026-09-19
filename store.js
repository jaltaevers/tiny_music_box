// Tile/settings persistence, PIN hashing, and import/export/share-link
// validation. Every storage access is wrapped in try/catch since it can
// throw (private browsing, full storage, disabled storage).
//
// The store holds multiple named kids, each with their own tiles and
// playback settings, plus one PIN shared by the whole device (not
// per-kid — it gates parent mode itself, before any kid is selected).
const STORAGE_KEY = 'kmt_config_v1';

export const DEFAULT_KID_SETTINGS = {
  kidName: '',
  endOfSong: 'continue', // 'stop' | 'repeat' | 'continue'
  maxVolume: 1,
  sleepTimerMinutes: null, // null | 15 | 30 | 45 | 60
  hideExplicit: true,
  tileDisplay: 'cover', // 'cover' (album art) | 'simple' (emoji + song name)
  visualizerMode: 'subtle', // 'off' | 'subtle' | 'winamp' — Winamp-style bars, cycled from one toggle button
  songLockEnabled: false, // once a song starts, refuses a tap on a different tile for a minute (kid-mode.js)
};

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.error(`Failed to read ${key}`, e);
    return null;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.error(`Failed to write ${key}`, e);
    return false;
  }
}

export function makeKidId() {
  return 'k_' + Math.random().toString(36).slice(2, 10);
}

export function makeTileId() {
  return 't_' + Math.random().toString(36).slice(2, 10);
}

// A tile's cover can be overridden with custom emoji instead of album art.
// Capped at 2 so it always fits legibly on a round tile (see kid-mode.js's
// .kid-tile-emoji-group--pair sizing) — matched here so extractEmoji()
// keeps the same first two a parent typed rather than a caller picking
// its own, different cutoff.
export const MAX_OVERRIDE_EMOJI = 2;

// Matches actual emoji glyphs — Extended_Pictographic covers virtually
// every standalone emoji, Regional_Indicator covers flag pairs (which
// aren't pictographic on their own) — while rejecting plain typed text.
const EMOJI_GLYPH_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

// Splits on user-perceived characters (via Intl.Segmenter), not UTF-16
// code units or code points, so a skin-tone modifier or a ZWJ sequence
// like a family emoji still counts — correctly — as one. Used both to
// validate what a parent just typed and, defensively, to re-derive
// something safe to render from tiles saved before this existed, or
// imported/shared from elsewhere with no guarantee they're clean.
export function extractEmoji(input, max = MAX_OVERRIDE_EMOJI) {
  if (!input) return [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const clusters = Array.from(segmenter.segment(input), (s) => s.segment);
  return clusters.filter((c) => EMOJI_GLYPH_RE.test(c)).slice(0, max);
}

function makeKid(name) {
  return {
    id: makeKidId(),
    tiles: [],
    sourcePlaylistUrl: null,
    settings: { ...DEFAULT_KID_SETTINGS, kidName: name || '' },
  };
}

function normalizeKid(k) {
  const saved = (k && k.settings) || {};
  const settings = { ...DEFAULT_KID_SETTINGS, ...saved };
  // Pre-winamp-mode saves only ever had a boolean showVisualizer; carry an
  // explicit off through as 'off' instead of silently losing it to the new
  // 'subtle' default. Checked against `saved` (pre-spread), since after the
  // spread above settings.visualizerMode is never undefined.
  if (saved.visualizerMode === undefined && saved.showVisualizer !== undefined) {
    settings.visualizerMode = saved.showVisualizer ? 'subtle' : 'off';
  }
  delete settings.showVisualizer;
  return {
    id: (k && k.id) || makeKidId(),
    tiles: Array.isArray(k && k.tiles) ? k.tiles : [],
    sourcePlaylistUrl: (k && k.sourcePlaylistUrl) || null,
    settings,
  };
}

// Pre-multi-kid saves looked like { tiles, settings: {...DEFAULT_KID_SETTINGS, pinHash} },
// one flat config for the whole device. Wrap that as this device's first
// kid, carrying its PIN over to the new device-level slot, so upgrading
// doesn't reset anything an existing family already set up.
function migrateLegacyStore(stored) {
  const legacySettings = stored.settings || {};
  const kid = {
    id: makeKidId(),
    tiles: Array.isArray(stored.tiles) ? stored.tiles : [],
    sourcePlaylistUrl: null,
    settings: {
      kidName: legacySettings.kidName || '',
      endOfSong: legacySettings.endOfSong || DEFAULT_KID_SETTINGS.endOfSong,
      maxVolume: legacySettings.maxVolume != null ? legacySettings.maxVolume : DEFAULT_KID_SETTINGS.maxVolume,
      sleepTimerMinutes: legacySettings.sleepTimerMinutes != null ? legacySettings.sleepTimerMinutes : null,
      hideExplicit: legacySettings.hideExplicit != null ? legacySettings.hideExplicit : true,
      tileDisplay: legacySettings.tileDisplay || DEFAULT_KID_SETTINGS.tileDisplay,
      visualizerMode: legacySettings.visualizerMode || (legacySettings.showVisualizer === false ? 'off' : DEFAULT_KID_SETTINGS.visualizerMode),
      songLockEnabled: legacySettings.songLockEnabled != null ? legacySettings.songLockEnabled : DEFAULT_KID_SETTINGS.songLockEnabled,
    },
  };
  return { kids: [kid], activeKidId: kid.id, pinHash: legacySettings.pinHash || null, familySeeded: false };
}

export function loadStore() {
  const stored = readJson(STORAGE_KEY);
  if (!stored) {
    const kid = makeKid('');
    return { kids: [kid], activeKidId: kid.id, pinHash: null, familySeeded: false };
  }
  if (Array.isArray(stored.kids) && stored.kids.length > 0) {
    const kids = stored.kids.map(normalizeKid);
    const activeKidId = kids.some((k) => k.id === stored.activeKidId) ? stored.activeKidId : kids[0].id;
    return { kids, activeKidId, pinHash: stored.pinHash || null, familySeeded: !!stored.familySeeded };
  }
  return migrateLegacyStore(stored);
}

export function saveStore(store) {
  return writeJson(STORAGE_KEY, {
    version: 2,
    kids: store.kids,
    activeKidId: store.activeKidId,
    pinHash: store.pinHash,
    familySeeded: !!store.familySeeded,
  });
}

// One-time seed: the three kids this app was actually built for, with the
// playlists their parent already had ready — pasted into chat, but never
// actually reachable from there (no path to fetch real Spotify data
// without that parent's own logged-in session). Pre-filling the link at
// least means opening Quick Setup for each kid here just needs one "Load
// playlist as tiles" tap instead of retyping the name and re-pasting the
// link. Runs once — the familySeeded flag keeps it from re-adding a kid
// that's since been renamed or removed on purpose. An existing kid's own
// tiles and playlist link (if already set) are left untouched.
const FAMILY_SEED = [
  { name: 'Rafa', playlistUrl: 'https://open.spotify.com/playlist/0cZMNCeq5IYNIBe4pY5YeA?si=KbvG6clTRv-RVIdWFJHcLg&utm_source=copy-link&pi=ICcMeTSgTMqZj' },
  { name: 'Alma', playlistUrl: 'https://open.spotify.com/playlist/2fisy00ch7XMPOHFXrlODV?si=6omhWRXNSOavUJvJvvC5mw&utm_source=copy-link&pi=sGV1CDrQRKqwa' },
  { name: 'Lily', playlistUrl: 'https://open.spotify.com/playlist/7jbCdxWJJSBu0KO8UzbRD5?si=mGiye45DTv6HYJSZy_Qo7A&utm_source=copy-link&pi=x9lQ7FjlR0eiI' },
];

function isBlankPlaceholderKid(k) {
  return !k.settings.kidName && k.tiles.length === 0 && !k.sourcePlaylistUrl;
}

export function seedFamilyIfNeeded(store) {
  if (store.familySeeded) return store;
  // loadStore()'s empty-storage case makes one nameless, empty kid just
  // so there's always something to hand kid-mode/parent-mode — that's a
  // placeholder, not something the user made, so seeding drops it rather
  // than leaving it sitting alongside the three real kids.
  let kids = store.kids.length === 1 && isBlankPlaceholderKid(store.kids[0]) ? [] : store.kids;
  for (const { name, playlistUrl } of FAMILY_SEED) {
    const existing = kids.find((k) => (k.settings.kidName || '').trim().toLowerCase() === name.toLowerCase());
    if (existing) {
      if (!existing.sourcePlaylistUrl) {
        kids = kids.map((k) => (k === existing ? { ...k, sourcePlaylistUrl: playlistUrl } : k));
      }
    } else {
      const kid = makeKid(name);
      kid.sourcePlaylistUrl = playlistUrl;
      kids = [...kids, kid];
    }
  }
  const activeKidId = kids.some((k) => k.id === store.activeKidId) ? store.activeKidId : kids[0].id;
  return { ...store, kids, activeKidId, familySeeded: true };
}

export function getActiveKid(store) {
  return store.kids.find((k) => k.id === store.activeKidId) || store.kids[0];
}

export function addKid(store, name) {
  const kid = makeKid(name);
  return { ...store, kids: [...store.kids, kid], activeKidId: kid.id };
}

// Always leaves at least one kid behind — an empty roster has nothing for
// kid mode to show and nowhere for parent mode to point the tab bar.
export function removeKid(store, kidId) {
  const kids = store.kids.filter((k) => k.id !== kidId);
  const safeKids = kids.length > 0 ? kids : [makeKid('')];
  const activeKidId = store.activeKidId === kidId ? safeKids[0].id : store.activeKidId;
  return { ...store, kids: safeKids, activeKidId };
}

export function tileFromTrack(track, overrides = {}) {
  return {
    id: makeTileId(),
    uri: track.uri,
    title: track.name,
    artist: (track.artists || []).map((a) => a.name).join(', '),
    albumArtUrl: track.album && track.album.images && track.album.images[0] ? track.album.images[0].url : null,
    durationMs: track.duration_ms || 0,
    explicit: !!track.explicit,
    override: null,
    ...overrides,
  };
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function hashPin(pin) {
  return sha256Hex(pin);
}

export async function checkPin(pin, pinHash) {
  if (!pinHash) return false;
  return (await sha256Hex(pin)) === pinHash;
}

const TRACK_URI_RE = /^spotify:track:[A-Za-z0-9]+$/;

// Imports/exports one kid at a time — the file a parent exports from
// "Songs" is that kid's tiles/settings, not the whole roster.
export function validateImportedConfig(data) {
  if (!data || typeof data !== 'object') throw new Error('Not a valid config file');
  if (!Array.isArray(data.tiles)) throw new Error('Missing tiles list');
  for (const tile of data.tiles) {
    if (!tile || typeof tile.uri !== 'string' || !TRACK_URI_RE.test(tile.uri)) {
      throw new Error(`Invalid track URI: ${tile && tile.uri}`);
    }
  }
  return {
    tiles: data.tiles.map((t) => ({
      id: t.id || makeTileId(),
      uri: t.uri,
      title: t.title || '',
      artist: t.artist || '',
      albumArtUrl: t.albumArtUrl || null,
      durationMs: t.durationMs || 0,
      explicit: !!t.explicit,
      override:
        t.override && typeof t.override.emoji === 'string'
          ? { emoji: t.override.emoji, color: t.override.color || '#5b5bd6' }
          : null,
    })),
    sourcePlaylistUrl: typeof data.sourcePlaylistUrl === 'string' ? data.sourcePlaylistUrl : null,
    settings: { ...DEFAULT_KID_SETTINGS, ...(data.settings || {}) },
  };
}

export function encodeShareLink(kid) {
  const compact = {
    v: 1,
    uris: kid.tiles.map((t) => t.uri),
    overrides: kid.tiles.reduce((acc, t, i) => {
      if (t.override) acc[i] = t.override;
      return acc;
    }, {}),
    sourcePlaylistUrl: kid.sourcePlaylistUrl || undefined,
    settings: kid.settings,
  };
  const json = JSON.stringify(compact);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const b64 = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${window.location.origin}${window.location.pathname}#setup=${b64}`;
}

export function decodeShareLinkHash(hash) {
  const match = /(?:^#|&)setup=([^&]+)/.exec(hash);
  if (!match) return null;
  let b64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const json = new TextDecoder().decode(bytes);
  const compact = JSON.parse(json);
  if (!Array.isArray(compact.uris)) {
    throw new Error('Setup link has no songs in it');
  }
  for (const uri of compact.uris) {
    if (!TRACK_URI_RE.test(uri)) throw new Error(`Setup link has an invalid track URI: ${uri}`);
  }
  return compact;
}
