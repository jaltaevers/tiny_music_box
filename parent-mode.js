import { tileFromTrack, validateImportedConfig, encodeShareLink, hashPin, extractEmoji, MAX_OVERRIDE_EMOJI } from './store.js';
import { fetchVideoMetadata } from './youtube-api.js';
import { confirmDialog, alertDialog, promptDialog } from './dialog.js';

const EMOJI_COLOR_DEFAULT = '#5b5bd6';

export function reorderArray(arr, fromIndex, toIndex) {
  const copy = arr.slice();
  const [moved] = copy.splice(fromIndex, 1);
  copy.splice(toIndex, 0, moved);
  return copy;
}

export function createParentMode({
  els,
  getSavedConfig,
  saveAndApply,
  getKids,
  getActiveKidId,
  onSwitchKid,
  onAddKid,
  onRemoveKid,
  onChangePin,
  onDone,
}) {
  let draft = null;
  let lastLookupResults = [];

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
    const row = document.createElement('div');
    row.className = 'result-row';
    const thumb = document.createElement('div');
    thumb.className = 'tile-thumb';
    if (track.thumbnailUrl) thumb.style.backgroundImage = `url("${track.thumbnailUrl}")`;
    else thumb.textContent = '🎵';

    const meta = document.createElement('div');
    meta.className = 'tile-meta';
    const titleEl = document.createElement('div');
    titleEl.className = 'tile-title';
    titleEl.textContent = track.title;
    const artistEl = document.createElement('div');
    artistEl.className = 'tile-artist';
    artistEl.textContent = track.channelTitle;
    meta.appendChild(titleEl);
    meta.appendChild(artistEl);

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'tile-action-btn';
    const uri = `youtube:video:${track.videoId}`;
    const already = existingUris().has(uri);
    addBtn.textContent = already ? 'Added' : 'Add';
    addBtn.disabled = already;
    addBtn.addEventListener('click', () => {
      draft.tiles.push(tileFromTrack(track));
      renderTileList();
      renderResults(lastLookupResults, els.addLinksResults);
    });

    row.appendChild(thumb);
    row.appendChild(meta);
    row.appendChild(addBtn);
    container.appendChild(row);
  }

  function renderResults(tracks, container) {
    container.innerHTML = '';
    tracks.forEach((t) => renderResultRow(t, container));
  }

  // Looks up every pasted link/id in parallel — each is an independent,
  // unauthenticated oEmbed call (see youtube-api.js), so there's no
  // shared rate limit or batching concern the way Spotify's chunked
  // getTracksByIds had. A link that fails (private video, typo, deleted)
  // is reported but doesn't block the others from showing up to add.
  async function lookupLinks() {
    els.addLinksError.hidden = true;
    const lines = els.addLinksInput.value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      els.addLinksError.hidden = false;
      els.addLinksError.textContent = 'Paste at least one YouTube link or video ID.';
      return;
    }

    els.addLinksBtn.disabled = true;
    els.addLinksBtn.textContent = 'Looking up…';
    try {
      const settled = await Promise.all(
        lines.map(async (line) => {
          try {
            return { ok: true, track: await fetchVideoMetadata(line) };
          } catch (e) {
            return { ok: false, input: line, message: e.message };
          }
        })
      );
      const tracks = settled.filter((r) => r.ok).map((r) => r.track);
      const failed = settled.filter((r) => !r.ok);

      lastLookupResults = tracks;
      renderResults(tracks, els.addLinksResults);
      els.addAllBtn.hidden = tracks.length === 0;

      if (failed.length > 0) {
        els.addLinksError.hidden = false;
        els.addLinksError.textContent =
          failed.length === lines.length
            ? `Couldn’t look up ${failed.length === 1 ? 'that link' : 'any of those'}: ${failed[0].message}`
            : `${failed.length} of ${lines.length} link(s) couldn’t be looked up (the rest are shown below): ${failed[0].message}`;
      }
    } finally {
      els.addLinksBtn.disabled = false;
      els.addLinksBtn.textContent = 'Look up';
    }
  }

  function addAllLookedUp() {
    const uris = existingUris();
    for (const track of lastLookupResults) {
      const uri = `youtube:video:${track.videoId}`;
      if (uris.has(uri)) continue;
      draft.tiles.push(tileFromTrack(track));
      uris.add(uri);
    }
    renderTileList();
    renderResults(lastLookupResults, els.addLinksResults);
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

  function bindAddLinks() {
    els.addLinksBtn.addEventListener('click', lookupLinks);
    els.addAllBtn.addEventListener('click', addAllLookedUp);
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
  }

  els.addKidBtn.addEventListener('click', async () => {
    const name = await promptDialog('New kid’s name:', '', { title: 'Add a kid' });
    if (name === null) return;
    onAddKid(name.trim());
  });

  bindSettings();
  bindAddLinks();
  bindSaveActions();

  return {
    // Synchronous on purpose: app.js calls this right after switching the
    // view to parent mode, and every settings/add-links control's event
    // listener (bound once, above, not per-show) reaches into `draft`
    // assuming it already exists the moment this view is interactive.
    show() {
      draft = JSON.parse(JSON.stringify(getSavedConfig()));
      clearRemoveUndoStatus();
      renderKidTabs();
      renderTileList();
      renderSettings();
      lastLookupResults = [];
      els.addLinksInput.value = '';
      els.addLinksResults.innerHTML = '';
      els.addLinksError.hidden = true;
      els.addAllBtn.hidden = true;
    },
  };
}
