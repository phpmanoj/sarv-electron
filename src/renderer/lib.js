'use strict';
/* Small DOM / formatting / dialog helpers. No framework on purpose:
   everything here is plain DOM so the UI stays easy to modify. */

const L = (function () {
  /* -------------------------------------------------------------- DOM */

  function el(tag, props, kids) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else if (k in node && k !== 'list') node[k] = v;
        else node.setAttribute(k, v);
      }
    }
    for (const kid of [].concat(kids || [])) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* ------------------------------------------------------- formatting */

  function fmtSize(bytes) {
    if (bytes === null || bytes === undefined) return '';
    const n = Number(bytes);
    if (!isFinite(n)) return '';
    if (n < 1024) return n + ' B';
    const units = ['KiB', 'MiB', 'GiB', 'TiB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + units[i];
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function fmtDate(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtTime(ms) {
    const d = new Date(ms || Date.now());
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function fileType(name, isDir) {
    if (isDir) return 'Directory';
    const dot = name.lastIndexOf('.');
    if (dot < 1) return 'File';
    return name.slice(dot + 1).toLowerCase() + ' file';
  }

  function modeToOctal(mode) {
    if (mode === null || mode === undefined) return '';
    return (mode & 0o777).toString(8).padStart(3, '0');
  }

  function octalToMode(text) {
    const t = String(text || '').trim();
    if (!/^[0-7]{3,4}$/.test(t)) return null;
    return parseInt(t, 8) & 0o777;
  }

  /* ----------------------------------------------------------- toasts */

  function toast(message, kind, ms) {
    const host = $('#toasts');
    const node = el('div', { class: 'toast ' + (kind || ''), text: message });
    host.append(node);
    setTimeout(() => node.remove(), ms || (kind === 'error' ? 7000 : 3500));
  }

  /* ---------------------------------------------------- context menu */

  let ctxOpen = false;

  function closeCtx() {
    const menu = $('#ctxmenu');
    menu.classList.add('hidden');
    menu.innerHTML = '';
    ctxOpen = false;
  }

  /** items: [{label, action, disabled, accel}] or 'sep' */
  function ctx(x, y, items) {
    const menu = $('#ctxmenu');
    menu.innerHTML = '';
    for (const item of items) {
      if (item === 'sep') { menu.append(el('hr')); continue; }
      if (!item) continue;
      menu.append(el('button', {
        disabled: Boolean(item.disabled),
        onclick: () => { closeCtx(); item.action(); },
      }, [item.label, item.accel ? el('kbd', { text: item.accel }) : null]));
    }
    menu.classList.remove('hidden');
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
    ctxOpen = true;
  }

  window.addEventListener('mousedown', (e) => {
    if (ctxOpen && !$('#ctxmenu').contains(e.target)) closeCtx();
  });
  window.addEventListener('blur', () => ctxOpen && closeCtx());

  /* ----------------------------------------------------------- modals */

  // Dialogs stack: opening one on top of another (e.g. Import from inside the
  // Site Manager) hides the one below instead of destroying it.
  const modalStack = [];

  function closeModal(value) {
    const host = $('#modal-host');
    const top = modalStack.pop();
    if (!top) return;
    top.box.remove();
    if (modalStack.length) {
      modalStack[modalStack.length - 1].box.style.display = '';
    } else {
      host.classList.add('hidden');
      host.innerHTML = '';
    }
    top.resolve(value);
  }

  /**
   * modal({ title, body, buttons:[{label, value, primary, danger, keep, onClick}], narrow })
   * Resolves with the clicked button's value (or null for Escape / backdrop).
   */
  function modal(opts) {
    const host = $('#modal-host');
    const foot = el('div', { class: 'foot' });
    for (const b of opts.buttons || [{ label: 'Close', value: null }]) {
      if (b === 'spacer') { foot.append(el('span', { class: 'spacer' })); continue; }
      foot.append(el('button', {
        class: (b.primary ? 'primary' : '') + (b.danger ? ' danger' : ''),
        text: b.label,
        onclick: () => {
          if (b.onClick) {
            const res = b.onClick();
            if (res === false) return; // keep the dialog open
          }
          if (!b.keep) closeModal(b.value === undefined ? b.label : b.value);
        },
      }));
    }

    const box = el('div', { class: 'modal' + (opts.narrow ? ' narrow' : '') }, [
      el('h2', { text: opts.title || '' }),
      el('div', { class: 'body' }, [opts.body]),
      foot,
    ]);

    if (modalStack.length) modalStack[modalStack.length - 1].box.style.display = 'none';
    host.append(box);
    host.classList.remove('hidden');
    host.onmousedown = (e) => { if (e.target === host) closeModal(null); };

    const focus = box.querySelector('input, select, textarea, button.primary');
    if (focus) setTimeout(() => focus.focus(), 30);

    return new Promise((resolve) => { modalStack.push({ box, resolve }); });
  }

  function isModalOpen() { return modalStack.length > 0; }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (ctxOpen) { closeCtx(); return; }
      if (modalStack.length) closeModal(null);
    }
  });

  /** Single-line text prompt. Resolves with the string, or null if cancelled. */
  async function promptText(opts) {
    const input = el('input', {
      value: opts.value || '',
      placeholder: opts.placeholder || '',
      style: 'width:100%',
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const btn = $('#modal-host button.primary');
          if (btn) btn.click();
        }
      },
    });
    const body = el('div', {}, [
      opts.label ? el('p', { class: 'hint', text: opts.label, style: 'margin:0 0 6px' }) : null,
      input,
      opts.hint ? el('p', { class: 'hint', text: opts.hint }) : null,
    ]);
    const res = await modal({
      title: opts.title || 'Enter value',
      body,
      narrow: true,
      buttons: [
        { label: 'Cancel', value: null },
        { label: opts.ok || 'OK', value: 'ok', primary: true },
      ],
    });
    if (res !== 'ok') return null;
    const value = input.value.trim();
    return value === '' ? null : value;
  }

  async function confirm(opts) {
    const body = el('div', {}, [el('p', { text: opts.message, style: 'margin:0; white-space:pre-wrap' })]);
    const res = await modal({
      title: opts.title || 'Confirm',
      body,
      narrow: true,
      buttons: [
        { label: opts.cancel || 'Cancel', value: false },
        { label: opts.ok || 'OK', value: true, primary: !opts.danger, danger: Boolean(opts.danger) },
      ],
    });
    return res === true;
  }

  /** Unwrap the { ok, data, error } envelope: shows a toast and returns null on failure. */
  function unwrap(res, context) {
    if (res && res.ok) return res.data;
    const msg = (res && res.error) || 'Unknown error';
    toast((context ? context + ': ' : '') + msg, 'error');
    return null;
  }

  return {
    el, $, $$, fmtSize, fmtDate, fmtTime, fileType, modeToOctal, octalToMode,
    toast, ctx, closeCtx, modal, closeModal, isModalOpen, promptText, confirm, unwrap,
  };
})();
