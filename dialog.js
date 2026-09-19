// Replaces window.confirm/alert/prompt everywhere in the app: those render
// as unstyled native browser chrome, which clashes with an otherwise fully
// custom UI in both kid and parent mode. One shared modal (markup lives in
// index.html, outside every .view so it works no matter which is showing)
// serves all three shapes; each exported function is a thin, Promise-based
// wrapper around it instead of the synchronous, blocking native versions.
let els = null;
let activeResolve = null;
let activeMode = null;

function elements() {
  if (!els) {
    els = {
      backdrop: document.getElementById('app-modal-backdrop'),
      title: document.getElementById('app-modal-title'),
      message: document.getElementById('app-modal-message'),
      input: document.getElementById('app-modal-input'),
      cancelBtn: document.getElementById('app-modal-cancel-btn'),
      confirmBtn: document.getElementById('app-modal-confirm-btn'),
    };
    els.confirmBtn.addEventListener('click', handleConfirmClick);
    els.cancelBtn.addEventListener('click', () => close(activeMode === 'prompt' ? null : false));
    els.backdrop.addEventListener('click', (e) => {
      if (e.target === els.backdrop) close(activeMode === 'prompt' ? null : false);
    });
    els.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleConfirmClick();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !els.backdrop.hidden) close(activeMode === 'prompt' ? null : false);
    });
  }
  return els;
}

function handleConfirmClick() {
  close(activeMode === 'prompt' ? elements().input.value : true);
}

function close(result) {
  const e = elements();
  e.backdrop.hidden = true;
  const resolve = activeResolve;
  activeResolve = null;
  activeMode = null;
  if (resolve) resolve(result);
}

function open({ title, message, mode, defaultValue = '', confirmLabel, cancelLabel = 'Cancel', danger = false, inputMode }) {
  return new Promise((resolve) => {
    const e = elements();
    // This app never stacks dialogs, but resolve any stranded prior one
    // (matching its own "user cancelled" shape) rather than leaving it
    // hanging forever if something ever did call a second one first.
    if (activeResolve) close(activeMode === 'prompt' ? null : false);

    activeResolve = resolve;
    activeMode = mode;

    e.title.textContent = title || '';
    e.title.hidden = !title;
    e.message.textContent = message || '';
    e.message.hidden = !message;

    const isPrompt = mode === 'prompt';
    e.input.hidden = !isPrompt;
    e.input.value = isPrompt ? defaultValue : '';
    if (inputMode) e.input.setAttribute('inputmode', inputMode);
    else e.input.removeAttribute('inputmode');

    // Explicitly passing cancelLabel: '' suppresses the cancel button even
    // in prompt mode — used for the "here's some text to copy" fallback
    // shape, which needs the input field but only one way to dismiss it.
    e.cancelBtn.hidden = mode === 'alert' || cancelLabel === '';
    e.cancelBtn.textContent = cancelLabel;
    e.confirmBtn.textContent = confirmLabel || (mode === 'confirm' ? 'Confirm' : 'OK');
    e.confirmBtn.classList.toggle('danger-btn', !!danger);

    e.backdrop.hidden = false;
    if (isPrompt) {
      e.input.focus();
      e.input.select();
    } else {
      e.confirmBtn.focus();
    }
  });
}

/** Like window.confirm, but returns a Promise<boolean> and never blocks. */
export function confirmDialog(message, { title, confirmLabel, cancelLabel, danger } = {}) {
  return open({ title, message, mode: 'confirm', confirmLabel, cancelLabel, danger });
}

/** Like window.alert, but returns a Promise<void> and never blocks. */
export async function alertDialog(message, { title, confirmLabel } = {}) {
  await open({ title, message, mode: 'alert', confirmLabel, cancelLabel: 'OK' });
}

/**
 * Like window.prompt, but returns a Promise<string|null> (null on cancel)
 * and never blocks. Also doubles for "show this text for the user to
 * copy" fallbacks (pass the text as defaultValue) where window.prompt was
 * previously (ab)used the same way when the Clipboard API wasn't available.
 */
export function promptDialog(message, defaultValue = '', { title, confirmLabel, cancelLabel, inputMode } = {}) {
  return open({ title, message, mode: 'prompt', defaultValue, confirmLabel, cancelLabel, inputMode });
}
