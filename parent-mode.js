import { tileFromTrack, validateImportedConfig, encodeShareLink, hashPin, extractEmoji, MAX_OVERRIDE_EMOJI } from './store.js';
import { getLoginAgeInfo, loadTokens } from './auth.js';
import { confirmDialog, alertDialog, promptDialog } from './dialog.js';

const EMOJI_COLOR_DEFAULT = '#5b5bd6';
const REQUIRED_PLAYLIST_SCOPE = 'playlist-read-private';

export function reorderArray(arr, fromIndex, toIndex) {
  const copy = arr.slice();
  const [moved] = copy.splice(fromIndex, 1);
  copy.splice(toIndex, 0, moved);
  return copy;
}

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function createParentMode({
  els,
  api,
  getSavedConfig,
  saveAndApply,
  getKids,
  getActiveKidId,
  onSwitchKid,
  onAddKid,
  onRemoveKid,
  onChangePin,
  onDone,
  onLogout,
  onRelogin,
  onReauthRequired,
}) {
  let draft = null;
  let searchOffset = 0;
  let searchQuery = '';
  let searchDebounce = null;

  function existingUris() {
    return new Set(draft.tiles.map((t) => t.uri));
  }

  function kidLabel(kid) {
    const name = kid.settings.kidName && kid.settings.kidName.trim();
    return name || 'Unnamed';
  }

  function renderKidTabs() {
    const kids = getKids();
    const activeId = getActiveKidId();
    els.kidTabs.innerHTML = '';
    kids.forEach((kid) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'kid-tab' + (kid.id === activeId ? ' active' : '');

      // A playlist link with still no songs means either it hasn't been
      // loaded yet or a background auto-fetch attempt failed silently —
      // this is the only place that would otherwise surface, since that
      // background fetch has nowhere else to report a failure to.
      if (kid.sourcePlaylistUrl && kid.tiles.length === 0) {
        const warn = document.createElement('span');
        warn.className = 'kid-tab-warning';
        warn.textContent = '⚠️';
        warn.setAttribute('aria-label', `${kidLabel(kid)} still needs songs loaded`);
        warn.title = 'Playlist linked but not loaded yet — open this tab and try Load playlist as tiles.';
        tab.appendChild(warn);
      }

      const label = document.createElement('span');
      label.textContent = kidLabel(kid);
      tab.appendChild(label);

      if (kids.length > 1) {
        const removeBtn = document.createElement('span');
        removeBtn.className = 'kid-tab-remove';
        removeBtn.textContent = '✕';
        removeBtn.setAttribute('role', 'button');
        removeBtn.setAttribute('aria-label', `Remove ${kidLabel(kid)}`);
        removeBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (await confirmDialog(`Remove ${kidLabel(kid)} and all their songs? This can’t be undone.`, { title: 'Remove kid', confirmLabel: 'Remove', danger: true })) {
            onRemoveKid(kid.id);
          }
        });
        tab.appendChild(removeBtn);
      }

      tab.addEventListener('click', () => switchKid(kid.id));
      els.kidTabs.appendChild(tab);
    });
  }

  async function switchKid(kidId) {
    if (kidId === getActiveKidId()) return;
    if (hasUnsavedChanges() && !(await confirmDialog('Switch kids without saving changes first?'))) return;
    onSwitchKid(kidId);
  }

  function renderAccount(profile) {
    els.accountInfo.textContent = profile ? profile.display_name || profile.id : 'Not logged in';
    const info = getLoginAgeInfo();
    if (info && info.expiringSoon) {
      els.tokenWarning.hidden = false;
      els.tokenWarning.textContent =
        info.daysRemaining > 0
          ? `Your Spotify login may need renewing in about ${info.daysRemaining} day(s).`
          : 'Your Spotify login may have expired — log in again if playback stops working.';
    } else {
      els.tokenWarning.hidden = true;
    }

    // A scope is granted (or not) once, at the moment this login was
    // created — adding playlist-read-private to config.js does nothing
    // for a session that logged in before that change. Without this
    // check, that shows up as every single playlist 403ing regardless of
    // who owns it, which reads exactly like an ownership problem but
    // isn't one.
    const tokens = loadTokens();
    const grantedScopes = (tokens && tokens.scope) || '';
    // Shown plainly rather than just checked internally — the "log in
    // again" fix for a missing scope has a real failure mode of its own
    // (Spotify silently reusing a prior consent instead of granting the
    // newly-requested one), so whether that actually worked needs to be
    // directly checkable rather than inferred from yet another guess. But
    // raw scope identifiers are pure developer jargon, so it's tucked
    // behind a collapsed "Technical details" disclosure (same pattern as
    // the login screen's own troubleshooting section) instead of dumped in
    // front of every parent on every visit.
    els.scopeDetails.hidden = !(tokens && tokens.scope);
    els.scopeInfo.textContent = tokens && tokens.scope ? `Permissions granted: ${tokens.scope}` : '';
    const missingPlaylistScope = !grantedScopes.split(' ').includes(REQUIRED_PLAYLIST_SCOPE);
    els.scopeWarning.hidden = !missingPlaylistScope;
    if (missingPlaylistScope) {
      els.scopeWarning.textContent =
        'This login doesn’t have permission to read playlists yet (added after you first logged in) — tap "Log in again" below to pick it up. No need to log out first.';
    }
  }

  function renderTileCount() {
    els.tileCount.textContent = String(draft.tiles.length);
    const tooFew = draft.tiles.length < 1;
    els.tileCountWarning.hidden = !tooFew;
    if (tooFew) {
      els.tileCountWarning.textContent = 'Add at least one song.';
    }
  }

  let pendingRemoveUndoTimer = null;

  function clearRemoveUndoStatus() {
    if (pendingRemoveUndoTimer) clearTimeout(pendingRemoveUndoTimer);
    pendingRemoveUndoTimer = null;
    els.tileRemoveStatus.hidden = true;
    els.tileRemoveStatus.innerHTML = '';
  }

  // A single tap permanently dropping a song with no recourse felt too easy
  // to trigger by accident while actively curating a list — but unlike kid
  // removal or a full playlist replace (both confirmDialog-gated below),
  // both rare and high-stakes, removing one song is common enough during
  // normal editing that a blocking confirm on every tap would be its own
  // annoyance. A brief, non-blocking undo covers the mis-tap instead.
  function removeTileWithUndo(index) {
    const [removed] = draft.tiles.splice(index, 1);
    renderTileList();

    clearRemoveUndoStatus();
    els.tileRemoveStatus.hidden = false;
    const text = document.createElement('span');
    text.textContent = `Removed “${removed.title || removed.uri}.”`;
    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.textContent = 'Undo';
    undoBtn.addEventListener('click', () => {
      draft.tiles.splice(index, 0, removed);
      renderTileList();
      clearRemoveUndoStatus();
    });
    els.tileRemoveStatus.appendChild(text);
    els.tileRemoveStatus.appendChild(undoBtn);
    pendingRemoveUndoTimer = setTimeout(clearRemoveUndoStatus, 6000);
  }

  function renderTileList() {
    els.tileList.innerHTML = '';
    draft.tiles.forEach((tile, index) => {
      const li = document.createElement('li');
      li.className = 'tile-row';

      const handle = document.createElement('span');
      handle.className = 'drag-handle';
      handle.textContent = '⠷';
      handle.setAttribute('aria-label', 'Drag to reorder');

      const thumb = document.createElement('div');
      thumb.className = 'tile-thumb';
      if (tile.override) {
        thumb.style.background = tile.override.color;
        thumb.textContent = tile.override.emoji;
      } else if (tile.albumArtUrl) {
        thumb.style.backgroundImage = `url("${tile.albumArtUrl}")`;
      } else {
        thumb.textContent = '🎵';
      }

      const meta = document.createElement('div');
      meta.className = 'tile-meta';
      const titleEl = document.createElement('div');
      titleEl.className = 'tile-title';
      titleEl.textContent = tile.title || tile.uri;
      const artistEl = document.createElement('div');
      artistEl.className = 'tile-artist';
      artistEl.textContent = tile.artist || '';
      meta.appendChild(titleEl);
      meta.appendChild(artistEl);
      if (tile.explicit) {
        const badge = document.createElement('span');
        badge.className = 'explicit-badge';
        badge.textContent = 'E';
        badge.setAttribute('aria-label', 'Explicit lyrics');
        badge.title = 'Explicit lyrics';
        meta.appendChild(badge);
      }

      const overrideBtn = document.createElement('button');
      overrideBtn.type = 'button';
      overrideBtn.className = 'tile-action-btn';
      overrideBtn.textContent = '🎨';
      overrideBtn.setAttribute('aria-label', 'Set emoji + color instead of album art');
      overrideBtn.addEventListener('click', () => openOverrideEditor(index));

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'tile-action-btn tile-remove-btn';
      removeBtn.textContent = '✕';
      removeBtn.setAttribute('aria-label', 'Remove');
      removeBtn.addEventListener('click', () => removeTileWithUndo(index));

      li.appendChild(handle);
      li.appendChild(thumb);
      li.appendChild(meta);
      li.appendChild(overrideBtn);
      li.appendChild(removeBtn);
      els.tileList.appendChild(li);
    });
    renderTileCount();
    setupDragReorder();
  }

  async function openOverrideEditor(index) {
    const tile = draft.tiles[index];
    const emoji = await promptDialog(`Emoji for this tile — up to ${MAX_OVERRIDE_EMOJI} (leave blank to use album art instead):`, tile.override ? tile.override.emoji : '', { title: 'Tile emoji' });
    if (emoji === null) return;
    if (emoji.trim() === '') {
      tile.override = null;
      renderTileList();
      return;
    }
    // Only real emoji are accepted (typed text is rejected outright rather
    // than saved as a broken-looking cover), and only up to
    // MAX_OVERRIDE_EMOJI of them — enough are silently dropped past that
    // to fit a pasted string too, without a confusing rejection for
    // something that mostly worked.
    const picked = extractEmoji(emoji);
    if (picked.length === 0) {
      await alertDialog(`That doesn't look like emoji — pick one or two from your device's emoji keyboard (up to ${MAX_OVERRIDE_EMOJI}), or leave it blank to use album art instead.`);
      return;
    }
    const color = tile.override ? tile.override.color : EMOJI_COLOR_DEFAULT;
    tile.override = { emoji: picked.join(''), color };
    openColorEditor(index);
    renderTileList();
  }

  function openColorEditor(index) {
    els.colorPickerInput.value = draft.tiles[index].override.color;
    els.colorPickerInput.onchange = () => {
      draft.tiles[index].override.color = els.colorPickerInput.value;
      renderTileList();
    };
    els.colorPickerInput.click();
  }

  let dragState = null;
  function setupDragReorder() {
    els.tileList.onpointerdown = (e) => {
      const handle = e.target.closest('.drag-handle');
      if (!handle) return;
      const row = handle.closest('.tile-row');
      const rows = Array.from(els.tileList.children);
      dragState = { pointerId: e.pointerId, startIndex: rows.indexOf(row), row, startY: e.clientY, targetIndex: rows.indexOf(row) };
      row.classList.add('dragging');
      try {
        handle.setPointerCapture(e.pointerId);
      } catch (err) {
        // ignore — capture is a nice-to-have, not required for correctness
      }
    };
    els.tileList.onpointermove = (e) => {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      const deltaY = e.clientY - dragState.startY;
      dragState.row.style.transform = `translateY(${deltaY}px)`;
      const rows = Array.from(els.tileList.children).filter((r) => r !== dragState.row);
      const currentCenter = dragState.row.offsetTop + dragState.row.offsetHeight / 2 + deltaY;
      let targetIndex = rows.length;
      for (let i = 0; i < rows.length; i++) {
        const rowCenter = rows[i].offsetTop + rows[i].offsetHeight / 2;
        if (currentCenter < rowCenter) {
          targetIndex = i;
          break;
        }
      }
      dragState.targetIndex = targetIndex;
    };
    const endDrag = (e) => {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      const { startIndex, targetIndex } = dragState;
      dragState.row.classList.remove('dragging');
      dragState.row.style.transform = '';
      dragState = null;
      if (targetIndex !== undefined && targetIndex !== startIndex) {
        draft.tiles = reorderArray(draft.tiles, startIndex, targetIndex > startIndex ? targetIndex - 1 : targetIndex);
        renderTileList();
      }
    };
    els.tileList.onpointerup = endDrag;
    els.tileList.onpointercancel = endDrag;
  }

  function renderResultRow(track, container) {
    if (draft.settings.hideExplicit && track.explicit) return;

    const row = document.createElement('div');
    row.className = 'result-row';
    const thumb = document.createElement('div');
    thumb.className = 'tile-thumb';
    const art = track.album && track.album.images && track.album.images[0];
    if (art) thumb.style.backgroundImage = `url("${art.url}")`;
    else thumb.textContent = '🎵';

    const meta = document.createElement('div');
    meta.className = 'tile-meta';
    const titleEl = document.createElement('div');
    titleEl.className = 'tile-title';
    titleEl.textContent = track.name;
    const artistEl = document.createElement('div');
    artistEl.className = 'tile-artist';
    artistEl.textContent = `${(track.artists || []).map((a) => a.name).join(', ')} · ${formatDuration(track.duration_ms)}`;
    meta.appendChild(titleEl);
    meta.appendChild(artistEl);
    if (track.explicit) {
      const badge = document.createElement('span');
      badge.className = 'explicit-badge';
      badge.textContent = 'E';
      badge.setAttribute('aria-label', 'Explicit lyrics');
      badge.title = 'Explicit lyrics';
      meta.appendChild(badge);
    }

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'tile-action-btn';
    const already = existingUris().has(track.uri);
    addBtn.textContent = already ? 'Added' : 'Add';
    addBtn.disabled = already;
    addBtn.addEventListener('click', () => {
      draft.tiles.push(tileFromTrack(track));
      renderTileList();
      renderResults(container === els.searchResults ? lastSearchResults : lastPlaylistResults, container);
    });

    row.appendChild(thumb);
    row.appendChild(meta);
    row.appendChild(addBtn);
    container.appendChild(row);
  }

  let lastSearchResults = [];
  let lastPlaylistResults = [];

  function renderResults(tracks, container) {
    container.innerHTML = '';
    tracks.forEach((t) => renderResultRow(t, container));
    // renderResultRow silently skips explicit tracks under the same
    // condition when hideExplicit is on — without this, a hidden result
    // just looks like a song that isn't on Spotify at all.
    const hiddenCount = draft.settings.hideExplicit ? tracks.filter((t) => t.explicit).length : 0;
    if (hiddenCount > 0) {
      const note = document.createElement('div');
      note.className = 'muted explicit-hidden-note';
      note.textContent = `${hiddenCount} explicit result${hiddenCount === 1 ? '' : 's'} hidden — turn off “Hide explicit tracks” in Settings to see them.`;
      container.appendChild(note);
    }
  }

  async function runSearch(reset) {
    if (!searchQuery.trim()) {
      lastSearchResults = [];
      renderResults([], els.searchResults);
      els.searchLoadMore.hidden = true;
      return;
    }
    if (reset) searchOffset = 0;
    try {
      const { items, hasMore } = await api.searchTracks(searchQuery, searchOffset, 10);
      lastSearchResults = reset ? items : lastSearchResults.concat(items);
      renderResults(lastSearchResults, els.searchResults);
      els.searchLoadMore.hidden = !hasMore;
      searchOffset += items.length;
    } catch (e) {
      handleApiError(e, els.searchResults);
    }
  }

  function handleApiError(e, container) {
    if (e && e.status === 401 && onReauthRequired) {
      onReauthRequired();
      return;
    }
    const el = document.createElement('div');
    el.className = 'warning';
    el.textContent = e && e.retryAfterSeconds ? `Spotify asked us to slow down — try again in ${e.retryAfterSeconds}s.` : (e && e.message) || 'Something went wrong';
    if (container) {
      container.innerHTML = '';
      container.appendChild(el);
    }
  }

  function extractSpotifyErrorDetail(body) {
    if (!body) return null;
    try {
      const parsed = JSON.parse(body);
      return (parsed && parsed.error && parsed.error.message) || null;
    } catch (e) {
      return null;
    }
  }

  function describePlaylistError(e) {
    if (e && e.status === 403) {
      const detail = extractSpotifyErrorDetail(e.body);
      const said = detail ? ` Spotify’s own message: “${detail}.”` : '';
      // Not a missing scope (checkable directly in Account → Permissions
      // granted) and not ownership (a fully public playlist 403s exactly
      // the same way, and ownership can't gate a public one) — both were
      // ruled out by direct testing, not assumption. What's left is
      // Spotify's Development Mode blocking playlist-track reads outright
      // until this app is granted Extended Quota Mode — check this app's
      // status at developer.spotify.com/dashboard.
      return `Can’t read this playlist (error 403).${said} This isn’t a login or ownership problem — a fully public playlist fails the same way. It looks like Spotify’s Development Mode is blocking playlist reading for this app entirely until it’s granted Extended Quota Mode (check this app’s status at the Spotify Developer Dashboard). Until then, add songs individually via Search instead — that endpoint isn’t affected.`;
    }
    return (e && e.message) || 'Couldn’t fetch that playlist.';
  }

  async function fetchPlaylist() {
    els.playlistError.hidden = true;
    els.playlistResults.innerHTML = '';
    els.playlistAddAllBtn.hidden = true;
    const link = els.playlistInput.value.trim();
    if (!link) return;
    try {
      const tracks = await api.getPlaylistItems(link);
      lastPlaylistResults = tracks;
      renderResults(tracks, els.playlistResults);
      els.playlistAddAllBtn.hidden = tracks.length === 0;
    } catch (e) {
      els.playlistError.hidden = false;
      els.playlistError.textContent = describePlaylistError(e);
    }
  }

  function renderQuickPlaylistLink() {
    // Re-derive the id from the stored URL rather than using it as-is:
    // extractPlaylistId only ever returns null or a bare alphanumeric id,
    // which keeps this safe to drop straight into an href even if
    // sourcePlaylistUrl came from an imported file or a setup link (both
    // of which can carry data from outside this app).
    const id = draft.sourcePlaylistUrl ? api.extractPlaylistId(draft.sourcePlaylistUrl) : null;
    els.quickPlaylistOpenRow.hidden = !id;
    if (id) els.quickPlaylistOpenLink.href = `https://open.spotify.com/playlist/${id}`;
  }

  async function quickSetupFromPlaylist() {
    els.quickPlaylistError.hidden = true;
    els.quickPlaylistStatus.textContent = '';
    const link = els.quickPlaylistInput.value.trim();
    if (!link) {
      els.quickPlaylistError.hidden = false;
      els.quickPlaylistError.textContent = 'Paste a playlist link first.';
      return;
    }
    if (draft.tiles.length > 0) {
      const ok = await confirmDialog(`This replaces your current ${draft.tiles.length} song(s) with tracks from this playlist. Continue?`, { title: 'Replace songs?' });
      if (!ok) return;
    }
    els.quickPlaylistStatus.textContent = 'Loading…';
    try {
      const tracks = await api.getPlaylistItems(link);
      const eligible = tracks.filter((t) => !(draft.settings.hideExplicit && t.explicit));
      if (eligible.length < 1) {
        els.quickPlaylistStatus.textContent = '';
        els.quickPlaylistError.hidden = false;
        els.quickPlaylistError.textContent =
          tracks.length === 0
            ? 'Couldn’t find any songs in that playlist — double check the link, or that it’s a playlist you own or collaborate on.'
            : 'Every song in that playlist is marked explicit, and explicit tracks are hidden — turn that off in Settings below, or add songs individually with Search.';
        return;
      }
      draft.tiles = eligible.map((t) => tileFromTrack(t));
      draft.sourcePlaylistUrl = link;
      renderTileList();
      renderQuickPlaylistLink();
      els.quickPlaylistStatus.textContent = `Loaded ${eligible.length} song(s) from this playlist — tap Save when you're happy, or fine-tune below first.`;
    } catch (e) {
      els.quickPlaylistStatus.textContent = '';
      els.quickPlaylistError.hidden = false;
      els.quickPlaylistError.textContent = describePlaylistError(e);
    }
  }

  function addAllFromPlaylist() {
    const uris = existingUris();
    for (const track of lastPlaylistResults) {
      if (uris.has(track.uri) || (draft.settings.hideExplicit && track.explicit)) continue;
      draft.tiles.push(tileFromTrack(track));
      uris.add(track.uri);
    }
    renderTileList();
    renderResults(lastPlaylistResults, els.playlistResults);
  }

  function renderSettings() {
    els.kidNameInput.value = draft.settings.kidName || '';
    els.tileDisplayRadios.forEach((r) => {
      r.checked = r.value === draft.settings.tileDisplay;
    });
    els.endOfSongRadios.forEach((r) => {
      r.checked = r.value === draft.settings.endOfSong;
    });
    els.visualizerModeRadios.forEach((r) => {
      r.checked = r.value === draft.settings.visualizerMode;
    });
    els.volumeSlider.value = String(Math.round(draft.settings.maxVolume * 100));
    els.volumeValue.textContent = els.volumeSlider.value;
    els.sleepTimerSelect.value = draft.settings.sleepTimerMinutes ? String(draft.settings.sleepTimerMinutes) : '';
    els.hideExplicitToggle.checked = draft.settings.hideExplicit;
    els.songLockToggle.checked = draft.settings.songLockEnabled;
  }

  function bindSettings() {
    els.kidNameInput.addEventListener('input', () => {
      draft.settings.kidName = els.kidNameInput.value;
    });
    els.tileDisplayRadios.forEach((r) => {
      r.addEventListener('change', () => {
        if (r.checked) draft.settings.tileDisplay = r.value;
      });
    });
    els.endOfSongRadios.forEach((r) => {
      r.addEventListener('change', () => {
        if (r.checked) draft.settings.endOfSong = r.value;
      });
    });
    els.visualizerModeRadios.forEach((r) => {
      r.addEventListener('change', () => {
        if (r.checked) draft.settings.visualizerMode = r.value;
      });
    });
    els.volumeSlider.addEventListener('input', () => {
      draft.settings.maxVolume = Number(els.volumeSlider.value) / 100;
      els.volumeValue.textContent = els.volumeSlider.value;
    });
    els.sleepTimerSelect.addEventListener('change', () => {
      draft.settings.sleepTimerMinutes = els.sleepTimerSelect.value ? Number(els.sleepTimerSelect.value) : null;
    });
    els.hideExplicitToggle.addEventListener('change', () => {
      draft.settings.hideExplicit = els.hideExplicitToggle.checked;
      renderResults(lastSearchResults, els.searchResults);
      renderResults(lastPlaylistResults, els.playlistResults);
    });
    els.songLockToggle.addEventListener('change', () => {
      draft.settings.songLockEnabled = els.songLockToggle.checked;
    });
    els.changePinBtn.addEventListener('click', async () => {
      const pin = await promptDialog('New 4-digit PIN:', '', { title: 'Change PIN', inputMode: 'numeric' });
      if (pin === null) return;
      if (!/^\d{4}$/.test(pin)) {
        await alertDialog('PIN must be exactly 4 digits.');
        return;
      }
      // Shared by the whole device (it gates parent mode itself, before any
      // kid is picked) rather than part of a kid's own draft, so this takes
      // effect right away instead of waiting on that kid's Save.
      await onChangePin(await hashPin(pin));
      await alertDialog('PIN updated.');
    });
  }

  function bindSearch() {
    els.searchInput.addEventListener('input', () => {
      searchQuery = els.searchInput.value;
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => runSearch(true), 400);
    });
    els.searchLoadMore.addEventListener('click', () => runSearch(false));
    els.playlistFetchBtn.addEventListener('click', fetchPlaylist);
    els.playlistAddAllBtn.addEventListener('click', addAllFromPlaylist);
    els.tabSearchBtn.addEventListener('click', () => switchTab('search'));
    els.tabPlaylistBtn.addEventListener('click', () => switchTab('playlist'));
  }

  function switchTab(tab) {
    els.tabSearchBtn.classList.toggle('active', tab === 'search');
    els.tabPlaylistBtn.classList.toggle('active', tab === 'playlist');
    els.searchPanel.hidden = tab !== 'search';
    els.playlistPanel.hidden = tab !== 'playlist';
  }

  function hasUnsavedChanges() {
    return JSON.stringify(draft) !== JSON.stringify(getSavedConfig());
  }

  function bindSaveActions() {
    els.saveBtn.addEventListener('click', async () => {
      if (draft.tiles.length < 1) {
        await alertDialog('Add at least one song before saving.');
        return;
      }
      saveAndApply(draft);
      els.saveStatus.textContent = 'Saved.';
      setTimeout(() => (els.saveStatus.textContent = ''), 2000);
    });

    els.exportBtn.addEventListener('click', () => {
      const blob = new Blob(
        [JSON.stringify({ version: 2, tiles: draft.tiles, sourcePlaylistUrl: draft.sourcePlaylistUrl, settings: draft.settings }, null, 2)],
        { type: 'application/json' }
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'kids-music-tiles-config.json';
      a.click();
      URL.revokeObjectURL(url);
    });

    els.importBtn.addEventListener('click', () => els.importFileInput.click());
    els.importFileInput.addEventListener('change', async () => {
      const file = els.importFileInput.files && els.importFileInput.files[0];
      els.importFileInput.value = '';
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = validateImportedConfig(JSON.parse(text));
        draft = { ...draft, ...parsed }; // keep this kid's id — only the tiles/settings/source are imported
        renderTileList();
        renderSettings();
        renderQuickPlaylistLink();
        els.saveStatus.textContent = 'Imported — tap Save to apply.';
      } catch (e) {
        await alertDialog('Couldn’t import that file: ' + e.message);
      }
    });

    els.copyLinkBtn.addEventListener('click', async () => {
      if (draft.tiles.length < 1) {
        await alertDialog('Add at least one song first.');
        return;
      }
      const link = encodeShareLink(draft);
      try {
        await navigator.clipboard.writeText(link);
        els.saveStatus.textContent = 'Setup link copied.';
      } catch (e) {
        await promptDialog('Copy this link:', link, { title: 'Setup link', cancelLabel: '' });
      }
      setTimeout(() => (els.saveStatus.textContent = ''), 2500);
    });

    async function handleDoneClick() {
      if (hasUnsavedChanges() && !(await confirmDialog('Discard unsaved changes?', { title: 'Discard changes?' }))) return;
      onDone();
    }
    els.doneBtn.addEventListener('click', handleDoneClick);
    els.doneBtnBottom.addEventListener('click', handleDoneClick);

    els.logoutBtn.addEventListener('click', onLogout);
    els.reloginBtn.addEventListener('click', onRelogin);
  }

  els.quickPlaylistBtn.addEventListener('click', quickSetupFromPlaylist);
  els.addKidBtn.addEventListener('click', async () => {
    const name = await promptDialog('New kid’s name:', '', { title: 'Add a kid' });
    if (name === null) return;
    onAddKid(name.trim());
  });

  bindSettings();
  bindSearch();
  bindSaveActions();

  return {
    // Synchronous on purpose: app.js calls this right after switching the
    // view to parent mode, and every settings/search control's event
    // listener (bound once, above, not per-show) reaches into `draft`
    // assuming it already exists. profile can be stale or null (whatever
    // was cached from the last /me fetch, or nothing yet on first login)
    // — it's only display info, and setAccountProfile() below fills in
    // the real thing once that fetch actually resolves, without touching
    // draft again and discarding whatever's being edited in the meantime.
    show(profile) {
      draft = JSON.parse(JSON.stringify(getSavedConfig()));
      clearRemoveUndoStatus();
      renderAccount(profile);
      renderKidTabs();
      renderTileList();
      renderSettings();
      lastSearchResults = [];
      lastPlaylistResults = [];
      els.searchInput.value = '';
      els.playlistInput.value = '';
      els.searchResults.innerHTML = '';
      els.playlistResults.innerHTML = '';
      els.playlistError.hidden = true;
      els.playlistAddAllBtn.hidden = true;
      els.quickPlaylistInput.value = draft.sourcePlaylistUrl || '';
      els.quickPlaylistStatus.textContent = '';
      els.quickPlaylistError.hidden = true;
      renderQuickPlaylistLink();
      switchTab('search');
    },
    // Updates just the Account panel once the real /me fetch resolves —
    // deliberately not routed through show() again, which would clobber
    // draft (and anything the parent's mid-editing) with a fresh copy of
    // the saved config.
    setAccountProfile(profile) {
      renderAccount(profile);
    },
  };
}
