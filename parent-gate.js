import { hashPin, checkPin } from './store.js';

export function createParentGate({ els, getConfig, saveSettings, onSuccess, onCancel }) {
  function render() {
    const hasPin = !!getConfig().settings.pinHash;
    els.title.textContent = hasPin ? 'Enter parent PIN' : 'Set a parent PIN';
    els.message.textContent = hasPin ? '' : 'Choose a 4-digit PIN you’ll use to get back into parent mode.';
    els.input.value = '';
    els.error.hidden = true;
    els.input.focus();
  }

  async function handleSubmit() {
    const pin = els.input.value.trim();
    if (!/^\d{4}$/.test(pin)) {
      els.error.textContent = 'Enter a 4-digit PIN.';
      els.error.hidden = false;
      return;
    }

    const hasPin = !!getConfig().settings.pinHash;
    if (!hasPin) {
      const pinHash = await hashPin(pin);
      saveSettings({ pinHash });
      onSuccess();
      return;
    }

    const ok = await checkPin(pin, getConfig().settings.pinHash);
    if (ok) {
      onSuccess();
    } else {
      els.error.textContent = 'Wrong PIN.';
      els.error.hidden = false;
      els.input.value = '';
      els.input.focus();
    }
  }

  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    handleSubmit();
  });
  els.cancelBtn.addEventListener('click', () => onCancel());

  return { show: render };
}
