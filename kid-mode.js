import { createVisualizer } from './visualizer.js';
import { extractEmoji } from './store.js';

const TAP_DEBOUNCE_MS = 800;
const HOLD_MS = 2250; // 75% of the original 3000ms
const FADE_MS = 30_000;
const SONG_LOCK_MS = 60_000;
const TILE_PALETTE = ['#FFADAD', '#FFD6A5', '#FDFFB6', '#CAFFBF', '#9BF6FF', '#A0C4FF', '#BDB2FF', '#FFC6FF'];
const SPARKLES = ['✨', '⭐', '🎉'];
// Cover mode: album art (or a manual emoji+color override), no text — for
// kids who recognize songs by photo. Simple mode: an emoji + the song's
// name on every tile — for kids who can read and would rather pick by
// name. This default emoji only applies when a tile has no manual
// override, which always wins in either mode.
const SIMPLE_MODE_EMOJI = ['🎵', '🎶', '🎤', '🥁', '🎸', '🎹', '🎺', '🌟', '🦄', '🌈', '🎈', '🐥', '🍭', '🚀', '🐬', '🎉'];

// Scales to any tile count (there's no fixed cap on how many a kid can
// have) by keeping the grid roughly square rather than stopping at a
// hardcoded ceiling — e.g. 4→2×2, 9→3×3, 16→4×4, 30→6×5. Very large
// counts still fit: .kid-grid falls back to scrolling rather than
// squeezing tiles down indefinitely.
function computeLayout(count) {
  if (count <= 0) return { cols: 1, rows: 1 };
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  return { cols, rows };
}

function isPortrait() {
  return window.matchMedia('(orientation: portrait)').matches;
}

// Renders 1 or 2 emoji glyphs (an override can hold up to
// MAX_OVERRIDE_EMOJI) as their own spans inside a shared wrapper, so CSS
// can center either count and shrink a pair to fit side by side — see
// .kid-tile-emoji-group(--pair) in style.css. Shared between the grid
// tiles and the smaller now-playing art, which pass their own glyphClass
// so each can size itself independently.
function appendEmojiGroup(container, glyphs, glyphClass) {
  const group = document.createElement('span');
  group.className = 'kid-tile-emoji-group' + (glyphs.length > 1 ? ' kid-tile-emoji-group--pair' : '');
  glyphs.forEach((glyph) => {
    const span = document.createElement('span');
    span.className = glyphClass;
    span.textContent = glyph;
    group.appendChild(span);
  });
  container.appendChild(group);
}

export function createKidMode({ els, player, getConfig, onOpenParentGate, onToggleVisualizer }) {
  const visualizer = createVisualizer({ canvas: els.visualizerCanvas });
  // Behind the tile grid, full-screen — unlike the strip above, this isn't
  // tied to the now-playing overlay being open: it should glow whenever a
  // song is actually playing, whether or not a kid has the overlay open or
  // is just looking at the grid.
  const bgVisualizer = createVisualizer({ canvas: els.bgVisualizerCanvas, variant: 'ambient-backdrop' });
  const lastTapAt = new Map();
  let activeTileIndex = -1;
  // The source of truth for "what's playing" — activeTileIndex is only
  // ever a position within *some* tile array, which is meaningless (or
  // actively misleading, pointing at an unrelated song) once a different
  // kid's differently-ordered grid renders. Every renderGrid() re-derives
  // activeTileIndex from this against the current tiles, and drops it —
  // hiding the now-playing bar — if it's not one of this kid's songs.
  let activeTrackUri = null;
  let holdTimer = null;
  let holdStartedAt = null;
  // Set only while settings.songLockEnabled — the currently "locked in"
  // song and how long it stays that way. Kept independent of
  // activeTrackUri (which the stop button clears) so stopping and
  // re-tapping the *same* tile still works during the lock window; only a
  // genuinely *different* tile is refused.
  let songLockedUntil = 0;
  let songLockedUri = null;
  let lockToastHideTimer = null;
  let sleepTimerHandle = null;
  let fadeIntervalHandle = null;
  let progressTickHandle = null;
  let lastState = { position: 0, durationMs: 0, updatedAt: 0, paused: true };

  function paintTileVisual(btn, tile, index, displayMode) {
    btn.innerHTML = '';
    const art = document.createElement('span');
    art.className = 'kid-tile-art';
    if (tile.override) {
      art.style.background = tile.override.color;
      // Re-extracted rather than trusted as-is: a tile saved before emoji
      // validation existed, or imported/shared from elsewhere, isn't
      // guaranteed to hold 1-2 clean emoji. Falling back to the plain
      // music-note keeps the parent's chosen color while never rendering
      // broken-looking text on the tile.
      const glyphs = extractEmoji(tile.override.emoji);
      if (glyphs.length) {
        appendEmojiGroup(art, glyphs, 'kid-tile-emoji');
      } else {
        appendEmojiGroup(art, ['🎵'], 'kid-tile-emoji kid-tile-emoji-fallback');
      }
    } else if (displayMode === 'simple') {
      appendEmojiGroup(art, [SIMPLE_MODE_EMOJI[index % SIMPLE_MODE_EMOJI.length]], 'kid-tile-emoji');
    } else if (tile.albumArtUrl) {
      art.style.backgroundImage = `url("${tile.albumArtUrl}")`;
    } else {
      // A track with no art and no manual override used to leave the tile
      // completely blank — just a flat color circle with no clue what it
      // is. A plain music-note reads as "this is a song" instead of "this
      // button is broken."
      appendEmojiGroup(art, ['🎵'], 'kid-tile-emoji kid-tile-emoji-fallback');
    }

    const eq = document.createElement('span');
    eq.className = 'kid-tile-eq';
    eq.innerHTML = '<i></i><i></i><i></i>';
    art.appendChild(eq);
    btn.appendChild(art);

    if (displayMode === 'simple') {
      const label = document.createElement('span');
      label.className = 'kid-tile-label';
      label.textContent = tile.title || '';
      btn.appendChild(label);
    }
  }

  function renderGrid() {
    const config = getConfig();
    const tiles = config.tiles;
    const displayMode = config.settings.tileDisplay === 'simple' ? 'simple' : 'cover';
    const { cols, rows } = computeLayout(tiles.length);
    const portrait = isPortrait();
    els.grid.style.setProperty('--cols', String(portrait ? rows : cols));
    els.grid.style.setProperty('--rows', String(portrait ? cols : rows));
    els.grid.innerHTML = '';

    tiles.forEach((tile, index) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'kid-tile';
      btn.style.setProperty('--tile-color', TILE_PALETTE[index % TILE_PALETTE.length]);
      btn.setAttribute('aria-label', tile.title || 'song');
      paintTileVisual(btn, tile, index, displayMode);
      btn.addEventListener('click', () => handleTap(index, btn));
      els.grid.appendChild(btn);
    });

    if (activeTrackUri) {
      const idx = tiles.findIndex((t) => t.uri === activeTrackUri);
      if (idx === -1) {
        // Whatever was last playing isn't one of this kid's songs (most
        // often: a different kid's grid is now showing) — nothing here
        // should claim to be "now playing".
        activeTileIndex = -1;
        activeTrackUri = null;
        closeNowPlaying();
      } else {
        activeTileIndex = idx;
        if (!els.overlay.hidden) renderNowPlayingArt();
      }
    }

    updateActiveTileVisual();
    renderGreeting();
  }

  function renderGreeting() {
    if (!els.greeting) return;
    const name = getConfig().settings.kidName && getConfig().settings.kidName.trim();
    els.greeting.hidden = !name;
    if (name) els.greeting.textContent = `🎵 ${name}’s Music`;
  }

  function spawnSparkles(originBtn) {
    if (!els.sparkleLayer || !originBtn) return;
    // Bursts from the round art itself, not the taller card (art + name)
    // originBtn now is — otherwise the burst centers on the gap between
    // the two instead of on the circle a kid just tapped.
    const rect = (originBtn.querySelector('.kid-tile-art') || originBtn).getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    for (let i = 0; i < 6; i++) {
      const span = document.createElement('span');
      span.className = 'sparkle';
      span.textContent = SPARKLES[i % SPARKLES.length];
      const angle = (Math.PI * 2 * i) / 6 + Math.random() * 0.5;
      const distance = 60 + Math.random() * 40;
      span.style.left = `${centerX}px`;
      span.style.top = `${centerY}px`;
      span.style.setProperty('--dx', `${Math.cos(angle) * distance}px`);
      span.style.setProperty('--dy', `${Math.sin(angle) * distance}px`);
      els.sparkleLayer.appendChild(span);
      const remove = () => span.remove();
      span.addEventListener('animationend', remove);
      // Fallback in case animationend doesn't fire for some reason — this
      // runs for hours unattended, so a stray sparkle must not linger.
      setTimeout(remove, 1000);
    }
  }

  function updateActiveTileVisual() {
    Array.from(els.grid.children).forEach((btn, i) => {
      btn.classList.toggle('is-playing', i === activeTileIndex);
    });
    els.grid.classList.toggle('has-active-tile', activeTileIndex !== -1);
  }

  // Only for a deliberate "I'm done" moment (the stop button, the sleep
  // timer finishing) — NOT folded into closeNowPlaying() itself, which
  // also runs on a kid switch or leaving for parent mode, where whatever
  // was playing may still genuinely be playing in the background and
  // should keep showing as active once kid mode comes back.
  function clearNowPlayingTile() {
    activeTileIndex = -1;
    activeTrackUri = null;
    updateActiveTileVisual();
  }

  // Phase 0 only ever proved one shape of play request reliable on the
  // target tablet: a single track, `playTracks([uri], 0)` (see spike/app.js).
  // "Continue to next tile" (the default) instead queues every tile in the
  // grid in one call and sets repeat mode before anything has played —
  // never exercised in that testing. pendingFullQueuePlay lets the
  // playback_error handler below fall back to the proven single-track
  // shape if that untested path fails, without double-starting playback
  // on the ordinary path where it succeeds.
  let pendingFullQueuePlay = null;

  function markTilePlaying(index) {
    activeTileIndex = index;
    activeTrackUri = getConfig().tiles[index] ? getConfig().tiles[index].uri : null;
    if (getConfig().settings.songLockEnabled && activeTrackUri) {
      songLockedUntil = Date.now() + SONG_LOCK_MS;
      songLockedUri = activeTrackUri;
    }
    updateActiveTileVisual();
    openNowPlaying();
    hideError();
  }

  // "Blocked songs mode": once a song is locked in, a tap on any *other*
  // tile is refused (with feedback below) until the minute is up — but the
  // *same* tile, the stop button, and play/pause are never refused, since
  // none of those actually swap in a different song.
  function showLockedFeedback(btn) {
    if (btn) {
      btn.classList.remove('is-locked-shake');
      void btn.offsetWidth; // restart the animation even on back-to-back refused taps
      btn.classList.add('is-locked-shake');
      const clearShake = () => btn.classList.remove('is-locked-shake');
      btn.addEventListener('animationend', clearShake, { once: true });
      setTimeout(clearShake, 500);
    }
    if (!els.lockToast) return;
    clearTimeout(lockToastHideTimer);
    els.lockToast.hidden = false;
    els.lockToast.classList.remove('is-visible');
    void els.lockToast.offsetWidth;
    els.lockToast.classList.add('is-visible');
    lockToastHideTimer = setTimeout(() => {
      els.lockToast.hidden = true;
    }, 1800);
  }

  async function handleTap(index, btn) {
    const config = getConfig();
    const tile = config.tiles[index];
    if (!tile) return;

    if (config.settings.songLockEnabled && Date.now() < songLockedUntil && tile.uri !== songLockedUri) {
      showLockedFeedback(btn);
      return;
    }

    const now = Date.now();
    if (now - (lastTapAt.get(tile.id) || 0) < TAP_DEBOUNCE_MS) return;
    lastTapAt.set(tile.id, now);
    spawnSparkles(btn);
    pendingFullQueuePlay = null;

    try {
      await player.activateElement();
      const mode = config.settings.endOfSong;
      if (mode === 'stop') {
        await player.playTracks([tile.uri], 0);
        player.setRepeatMode('off').catch(() => {});
      } else if (mode === 'repeat') {
        await player.playTracks([tile.uri], 0);
        player.setRepeatMode('track').catch(() => {});
      } else {
        pendingFullQueuePlay = { tile, at: Date.now() };
        await player.playTracks(
          config.tiles.map((t) => t.uri),
          index
        );
        player.setRepeatMode('context').catch(() => {});
      }
      await player.setVolume(config.settings.maxVolume);
      markTilePlaying(index);
    } catch (e) {
      if (pendingFullQueuePlay) {
        // The untested full-queue request itself was rejected (rather
        // than accepted and failing later) — fall back right away.
        pendingFullQueuePlay = null;
        try {
          await player.playTracks([tile.uri], 0);
          await player.setVolume(config.settings.maxVolume);
          markTilePlaying(index);
          return;
        } catch (e2) {
          showError(e2);
          return;
        }
      }
      showError(e);
    }
  }

  // The visualizer is a per-kid preference (like tileDisplay or
  // hideExplicit) but, unlike those, it's cycled from a single tap on the
  // now-playing bar rather than edited as a draft in parent mode and
  // committed with Save — there's nothing to confirm, so it takes effect
  // and persists immediately, the same way onChangePin does. One tap
  // cycles off -> subtle -> winamp -> off, the same click-to-cycle feel
  // real Winamp's visualizer had, and one setting governs both visual
  // surfaces (the now-playing strip and the tile-grid backdrop) — it's one
  // feature with two views of the same thing, not two toggles to keep in
  // sync. Only the backdrop's own rendering changes between subtle/winamp;
  // the strip is already a fully-lit display, so it just turns on or off.
  function refreshVisualizers() {
    const mode = getConfig().settings.visualizerMode;
    const enabled = mode !== 'off';
    els.vizToggleBtn.setAttribute('aria-pressed', String(enabled));
    els.vizToggleBtn.classList.toggle('is-active', enabled);
    els.vizToggleBtn.classList.toggle('is-winamp', mode === 'winamp');
    els.vizToggleBtn.setAttribute('aria-label', `Music visualizer: ${mode === 'off' ? 'off, tap for subtle' : mode === 'subtle' ? 'subtle, tap for winamp mode' : 'winamp mode, tap to turn off'}`);

    // Now-playing strip: only makes sense while that overlay is open.
    if (enabled && !els.overlay.hidden) {
      visualizer.setVariant(mode === 'winamp' ? 'bar-strip-winamp' : 'bar-strip');
      els.visualizerCanvas.hidden = false;
      visualizer.start();
    } else {
      els.visualizerCanvas.hidden = true;
      visualizer.stop();
    }

    // Tile-grid backdrop: independent of the overlay — the grid behind
    // which it sits is visible any time kid mode itself is, whether or not
    // the now-playing overlay happens to be open. setPlaying() (driven by
    // the player state listener below) is what makes it glow only while
    // something's actually playing versus sitting quietly at rest.
    if (enabled) {
      bgVisualizer.setVariant(mode === 'winamp' ? 'winamp-backdrop' : 'ambient-backdrop');
      els.bgVisualizerCanvas.hidden = false;
      bgVisualizer.start();
    } else {
      els.bgVisualizerCanvas.hidden = true;
      bgVisualizer.stop();
    }
    updateGridClearance();
  }

  // The now-playing bar floats *over* the grid rather than taking up
  // layout space of its own (so it can float above the safe area instead
  // of shoving the whole grid up), which otherwise left its bottom row of
  // tiles permanently covered with no way to scroll them clear. Padding
  // the grid's own scrollable area by exactly the bar's rendered height
  // (which changes with the visualizer strip showing/hiding) means the
  // last row can always be scrolled up above it.
  function updateGridClearance() {
    if (els.overlay.hidden) {
      els.grid.style.removeProperty('--overlay-clearance');
      return;
    }
    const rect = els.overlay.getBoundingClientRect();
    const clearance = Math.max(0, window.innerHeight - rect.top) + 16;
    els.grid.style.setProperty('--overlay-clearance', `${clearance}px`);
  }

  function openNowPlaying() {
    els.overlay.hidden = false;
    renderNowPlayingArt();
    startProgressTicker();
    armSleepTimer();
    refreshVisualizers();
  }

  function closeNowPlaying() {
    els.overlay.hidden = true;
    stopProgressTicker();
    els.visualizerCanvas.hidden = true;
    visualizer.stop();
    updateGridClearance();
  }

  function renderNowPlayingArt() {
    const config = getConfig();
    const tile = config.tiles[activeTileIndex];
    if (els.npTitle) els.npTitle.textContent = tile ? tile.title || '' : '';
    els.npArt.innerHTML = '';
    els.npArt.style.background = '';
    els.npArt.style.backgroundImage = '';
    if (!tile) return;
    if (tile.override) {
      els.npArt.style.background = tile.override.color;
      const glyphs = extractEmoji(tile.override.emoji);
      if (glyphs.length) {
        appendEmojiGroup(els.npArt, glyphs, 'kid-tile-emoji np-emoji');
      } else {
        appendEmojiGroup(els.npArt, ['🎵'], 'kid-tile-emoji np-emoji kid-tile-emoji-fallback');
      }
    } else if (tile.albumArtUrl) {
      els.npArt.style.backgroundImage = `url("${tile.albumArtUrl}")`;
    } else {
      appendEmojiGroup(els.npArt, ['🎵'], 'kid-tile-emoji np-emoji kid-tile-emoji-fallback');
    }
  }

  function startProgressTicker() {
    stopProgressTicker();
    progressTickHandle = setInterval(() => {
      if (lastState.paused || !lastState.durationMs) return;
      const elapsed = lastState.position + (Date.now() - lastState.updatedAt);
      const pct = Math.min(100, (elapsed / lastState.durationMs) * 100);
      els.progressBar.style.width = pct + '%';
    }, 250);
  }
  function stopProgressTicker() {
    if (progressTickHandle) clearInterval(progressTickHandle);
    progressTickHandle = null;
  }

  function armSleepTimer() {
    clearSleepTimer();
    const minutes = getConfig().settings.sleepTimerMinutes;
    if (!minutes) return;
    const totalMs = minutes * 60_000;
    sleepTimerHandle = setTimeout(() => {
      startFadeOut(getConfig().settings.maxVolume);
    }, Math.max(0, totalMs - FADE_MS));
  }
  function clearSleepTimer() {
    if (sleepTimerHandle) clearTimeout(sleepTimerHandle);
    sleepTimerHandle = null;
    if (fadeIntervalHandle) clearInterval(fadeIntervalHandle);
    fadeIntervalHandle = null;
  }

  function startFadeOut(fromVolume) {
    const steps = 20;
    let step = 0;
    fadeIntervalHandle = setInterval(() => {
      step++;
      const vol = Math.max(0, fromVolume * (1 - step / steps));
      player.setVolume(vol).catch(() => {});
      if (step >= steps) {
        clearInterval(fadeIntervalHandle);
        fadeIntervalHandle = null;
        player.pause().catch(() => {});
        clearNowPlayingTile();
      }
    }, FADE_MS / steps);
  }

  function showError(e) {
    els.error.hidden = false;
    els.errorDetail.textContent = (e && e.message) || 'Something went wrong';
  }
  function hideError() {
    els.error.hidden = true;
  }

  function handlePlayPauseTap() {
    if (lastState.paused) {
      player.resume().catch((e) => showError(e));
    } else {
      player.pause().catch((e) => showError(e));
    }
  }

  function startHold() {
    els.parentGateBtn.classList.add('is-holding');
    holdStartedAt = performance.now();
    holdTimer = setTimeout(endHold, HOLD_MS);
  }
  // Bound to the timer firing on schedule AND to pointerup/leave/cancel —
  // whichever comes first normally wins, but under heavy main-thread load
  // (two visualizer rAF loops repainting full-screen canvases while a song
  // plays) the timer callback can land late enough that the pointer's own
  // release event fires first even though the hold genuinely lasted long
  // enough. Judging by elapsed time rather than by which event happened to
  // arrive first means a real HOLD_MS-long press always opens the gate
  // regardless of that race — this is the parent's only way into PIN-
  // protected settings, so it shouldn't be able to silently drop a
  // successful hold under load.
  function endHold() {
    els.parentGateBtn.classList.remove('is-holding');
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    const heldLongEnough = holdStartedAt !== null && performance.now() - holdStartedAt >= HOLD_MS;
    holdStartedAt = null;
    if (heldLongEnough) onOpenParentGate();
  }

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
    visualizer.setPlaying(!state.paused);
    bgVisualizer.setPlaying(!state.paused);

    // "Continue to next tile" queues the whole grid and lets Spotify
    // auto-advance through it on its own — when it does, this is the only
    // signal that the current track actually changed. Without this, the
    // now-playing art (and the grid's is-playing highlight) stayed frozen
    // on whichever tile was originally tapped instead of following along.
    //
    // Gated on an actively-*playing* report on purpose: pausing (including
    // the stop button's own player.pause() call, just below) still reports
    // the just-paused track in track_window — often only after a real
    // async round-trip to the Spotify Connect device, arriving well after
    // the stop button has already cleared activeTileIndex — and reacting
    // to that stale report here would silently undo an explicit stop and
    // re-highlight a tile the kid just turned off.
    if (!state.paused && track && track.uri) {
      const config = getConfig();
      const newIndex = config.tiles.findIndex((t) => t.uri === track.uri);
      if (newIndex !== -1 && newIndex !== activeTileIndex) {
        activeTileIndex = newIndex;
        activeTrackUri = track.uri;
        updateActiveTileVisual();
        renderNowPlayingArt();
      }
    }
  });

  player.onEvent(({ type }) => {
    // The SDK can accept a play request (no throw) and only report failure
    // moments later via this event — the case handleTap's own catch can't
    // see. If it's this tap's untested full-queue request, fall back to
    // the single-track shape Phase 0 proved reliable instead of just
    // showing an error for something a retry would likely fix.
    if (type === 'playback_error' && pendingFullQueuePlay && Date.now() - pendingFullQueuePlay.at < 5000) {
      const { tile } = pendingFullQueuePlay;
      pendingFullQueuePlay = null;
      const config = getConfig();
      const index = config.tiles.findIndex((t) => t.id === tile.id);
      player
        .playTracks([tile.uri], 0)
        .then(() => player.setVolume(config.settings.maxVolume))
        .then(() => markTilePlaying(index))
        .catch((e) => showError(e));
      return;
    }
    pendingFullQueuePlay = null;
    if (['account_error', 'playback_error', 'initialization_error', 'authentication_error'].includes(type)) {
      showError(new Error(type));
    }
  });

  els.parentGateBtn.addEventListener('pointerdown', startHold);
  els.parentGateBtn.addEventListener('pointerup', endHold);
  els.parentGateBtn.addEventListener('pointerleave', endHold);
  els.parentGateBtn.addEventListener('pointercancel', endHold);
  els.backBtn.addEventListener('click', () => {
    // Used to only hide this bar while the song kept playing out of sight —
    // easy to mistake for a button that does nothing at all. Pausing first
    // gives it an effect a kid can actually hear, and clearing the tile
    // stops it from bouncing/glowing as "playing" forever afterward.
    player.pause().catch(() => {});
    clearNowPlayingTile();
    closeNowPlaying();
  });
  els.playPause.addEventListener('click', handlePlayPauseTap);
  els.vizToggleBtn.addEventListener('click', () => {
    const order = ['off', 'subtle', 'winamp'];
    const current = order.indexOf(getConfig().settings.visualizerMode);
    onToggleVisualizer(order[(Math.max(current, 0) + 1) % order.length]);
    refreshVisualizers();
  });

  let resizeDebounce = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(() => {
      renderGrid();
      visualizer.handleResize();
      bgVisualizer.handleResize();
      updateGridClearance();
    }, 150);
  });

  return {
    show() {
      renderGrid();
      refreshVisualizers();
    },
    hide() {
      closeNowPlaying();
      clearSleepTimer();
      els.bgVisualizerCanvas.hidden = true;
      bgVisualizer.stop();
    },
  };
}
