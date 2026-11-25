/**
 * In-app replacements for the browser's confirm() and prompt() so dialogs match the rest of the design.
 * Both return promises: confirm -> boolean, prompt -> string | null.
 */
(() => {
  const $ = id => document.getElementById(id);
  let settle = null;

  function close(result) {
    $('dialogModal').classList.add('hidden');
    if (!document.querySelector('.modal:not(.hidden)')) document.body.style.overflow = '';
    const done = settle;
    settle = null;
    if (done) done(result);
  }

  function open({ title, message = '', confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false, icon = 'circle-alert', input = null }) {
    if (settle) close(null);
    $('dialogTitle').textContent = title;
    $('dialogMessage').textContent = message;
    $('dialogMessage').classList.toggle('hidden', !message);
    $('dialogOk').textContent = confirmLabel;
    $('dialogOk').className = `btn ${danger ? 'btn-danger-fill' : 'btn-primary'}`;
    $('dialogCancel').textContent = cancelLabel;
    $('dialogIcon').className = `dialog-icon${danger ? ' is-danger' : ''}`;
    $('dialogIcon').innerHTML = `<svg class="i"><use href="/icons.svg#i-${icon}"/></svg>`;

    const field = $('dialogInput');
    field.classList.toggle('hidden', input === null);
    if (input !== null) {
      field.value = input.value ?? '';
      field.placeholder = input.placeholder ?? '';
    }

    $('dialogModal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    setTimeout(() => (input !== null ? field : $('dialogOk')).focus(), 30);

    return new Promise(resolve => {
      settle = value => resolve(input !== null ? (value === true ? field.value.trim() : null) : value === true);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('dialogOk').addEventListener('click', () => close(true));
    $('dialogCancel').addEventListener('click', () => close(false));
    $('dialogModal').addEventListener('mousedown', e => { if (e.target === $('dialogModal')) close(false); });
    $('dialogInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); close(true); } });
  });

  // Capture phase so Escape closes only this dialog, not the modal underneath it
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && settle) {
      e.stopImmediatePropagation();
      close(false);
    }
  }, true);

  window.UiDialog = {
    confirm: options => open(options),
    prompt: options => open({ ...options, input: options.input ?? { value: '' } })
  };
})();
