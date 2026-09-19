// Thin wrapper around the Spotify Web Playback SDK, kept behind a small,
// swappable interface: init, playTracks, pause, resume, next, previous,
// setVolume, getState, onStateChange (+ onEvent, activateElement,
// setRepeatMode). If the SDK proves unreliable on the target tablet, this
// module is the one place a Spotify Connect remote-control implementation
// would replace, without touching UI code.

const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';

let sdkLoadPromise = null;
function loadSdk() {
  if (sdkLoadPromise) return sdkLoadPromise;
  sdkLoadPromise = new Promise((resolve, reject) => {
    if (window.Spotify) {
      resolve(window.Spotify);
      return;
    }
    window.onSpotifyWebPlaybackSDKReady = () => resolve(window.Spotify);
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.onerror = () => reject(new Error('Failed to load the Spotify Web Playback SDK script'));
    document.head.appendChild(script);
  });
  return sdkLoadPromise;
}

export function createPlayer({ name, getOAuthToken, volume = 1, api }) {
  let player = null;
  let deviceId = null;
  const stateListeners = new Set();
  const eventListeners = new Set();
  let playInFlight = null;

  function emitEvent(type, data) {
    for (const listener of eventListeners) {
      try {
        listener({ type, data });
      } catch (e) {
        console.error('event listener threw', e);
      }
    }
  }
  function emitState(state) {
    for (const listener of stateListeners) {
      try {
        listener(state);
      } catch (e) {
        console.error('state listener threw', e);
      }
    }
  }

  async function init() {
    const Spotify = await loadSdk();
    player = new Spotify.Player({ name, getOAuthToken, volume });

    for (const eventName of ['initialization_error', 'authentication_error', 'account_error', 'playback_error', 'autoplay_failed']) {
      player.addListener(eventName, (payload) => emitEvent(eventName, payload));
    }
    player.addListener('ready', ({ device_id }) => {
      deviceId = device_id;
      emitEvent('ready', { device_id });
    });
    player.addListener('not_ready', ({ device_id }) => emitEvent('not_ready', { device_id }));
    player.addListener('player_state_changed', (state) => {
      emitEvent('player_state_changed', state);
      emitState(state);
    });

    const connected = await player.connect();
    emitEvent('connect_result', { connected });
    if (!connected) throw new Error('Spotify.Player.connect() returned false');
  }

  function requireDeviceId() {
    if (!deviceId) throw new Error('Player not ready yet: no device_id.');
    return deviceId;
  }

  // The SDK's 'ready' event can fire slightly before Spotify's backend has
  // fully registered the device with the Connect API, so a play/pause/etc.
  // call right after 'ready' can 404 with "Device not found" even though
  // the id is correct — observed directly during Phase 0 testing. Retry a
  // few times with backoff before treating it as a real failure.
  async function withDeviceRetry(fn, retries = 3, delayMs = 400) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        const isDeviceRace = e.status === 404 && /device not found/i.test(e.body || '');
        if (isDeviceRace && attempt < retries) {
          emitEvent('device_retry', { attempt });
          await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
  }

  async function playTracks(uris, offset = 0) {
    const id = requireDeviceId();
    if (playInFlight) await playInFlight.catch(() => {});
    playInFlight = withDeviceRetry(() =>
      api.request(`/me/player/play?device_id=${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({ uris, offset: { position: offset } }),
      })
    ).finally(() => {
      playInFlight = null;
    });
    return playInFlight;
  }

  function pause() {
    const id = requireDeviceId();
    return withDeviceRetry(() => api.request(`/me/player/pause?device_id=${encodeURIComponent(id)}`, { method: 'PUT' }));
  }

  async function resume() {
    if (player) await player.resume();
  }

  function next() {
    const id = requireDeviceId();
    return withDeviceRetry(() => api.request(`/me/player/next?device_id=${encodeURIComponent(id)}`, { method: 'POST' }));
  }

  function previous() {
    const id = requireDeviceId();
    return withDeviceRetry(() => api.request(`/me/player/previous?device_id=${encodeURIComponent(id)}`, { method: 'POST' }));
  }

  // Sets volume through two independent paths rather than trusting either
  // alone: the SDK's own player.setVolume() adjusts gain inside this
  // browser tab's local playback pipeline, while api.setDeviceVolume() hits
  // Spotify Connect directly to set the device's volume server-side. Errors
  // are logged rather than swallowed — a silent failure here is exactly
  // what "the slider doesn't do anything" looks like from the outside, with
  // nothing to go on for why.
  async function setVolume(value) {
    const clamped = Math.max(0, Math.min(1, value));
    await Promise.all([
      player ? player.setVolume(clamped).catch((e) => console.error('SDK setVolume failed', e)) : null,
      deviceId ? api.setDeviceVolume(deviceId, clamped * 100).catch((e) => console.error('Connect setVolume failed', e)) : null,
    ]);
  }

  async function getState() {
    return player ? player.getCurrentState() : null;
  }

  function setRepeatMode(mode) {
    const id = requireDeviceId();
    return withDeviceRetry(() => api.setRepeatMode(id, mode));
  }

  function onStateChange(listener) {
    stateListeners.add(listener);
    return () => stateListeners.delete(listener);
  }
  function onEvent(listener) {
    eventListeners.add(listener);
    return () => eventListeners.delete(listener);
  }

  async function activateElement() {
    // Must run synchronously inside the tap handler (before any other
    // await) so the browser still counts this as a user gesture.
    if (player && typeof player.activateElement === 'function') {
      await player.activateElement();
    }
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
    getDeviceId: () => deviceId,
  };
}
