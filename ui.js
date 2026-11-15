/* =====================================================================
   ui.js — small UI helpers: DOM, toasts, confirm dialog, modal, busy buttons.
   User-supplied text is ALWAYS inserted with textContent (never innerHTML).
   ===================================================================== */
(function () {
  'use strict';
  const PM = window.PM;

  PM.$  = (sel, root = document) => root.querySelector(sel);
  PM.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /** el('div', {class:'x', onclick: fn}, 'text', childNode) */
  PM.el = function (tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return n;
  };

  PM.debounce = function (fn, ms) {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };

  /** Bangla/Arabic-Indic digits -> 0-9 (so "০১৭১২…" works for mobile numbers and codes). */
  PM.toAsciiDigits = function (s) {
    return String(s ?? '')
      .replace(/[০-৯]/g, (c) => String(c.charCodeAt(0) - 0x09E6))
      .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660));
  };

  PM.fmtDateTime = (iso) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  PM.fmtDay = (iso) => { const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`; };
  PM.startOfLocalDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

  /* ---------- toasts ---------- */
  PM.toast = function (message, type = 'info', ms = 4200) {
    const box = PM.$('#toasts');
    const t = PM.el('div', { class: 'toast toast-' + type, role: type === 'error' ? 'alert' : 'status' }, message);
    box.append(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, ms);
  };

  /* ---------- modal ---------- */
  PM.modal = function (content, { wide = false } = {}) {
    const root = PM.$('#modal-root');
    const overlay = PM.el('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true' });
    const box = PM.el('div', { class: 'dialog' + (wide ? ' wide' : '') }, content);
    overlay.append(box);
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    root.append(overlay);
    return { close, box };
  };

  /** await PM.confirm({title, message, okText, danger}) -> true / false */
  PM.confirm = function ({ title, message, okText = 'OK', cancelText = 'Cancel', danger = false }) {
    return new Promise((resolve) => {
      let m;
      const done = (v) => { m.close(); resolve(v); };
      const cancel = PM.el('button', { class: 'btn', type: 'button', onclick: () => done(false) }, cancelText);
      const ok = PM.el('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), type: 'button', onclick: () => done(true) }, okText);
      m = PM.modal([PM.el('h2', {}, title), PM.el('p', {}, message), PM.el('div', { class: 'actions-row' }, cancel, ok)]);
      cancel.focus();
    });
  };

  /** Disable a button and show a spinner while an async action runs. */
  PM.setBusy = function (btn, on, text) {
    if (!btn) return;
    if (on) {
      if (btn.dataset.busy === '1') return;
      btn.dataset.busy = '1';
      btn.dataset.label = btn.textContent;
      btn.disabled = true;
      btn.replaceChildren(PM.el('span', { class: 'spinner', 'aria-hidden': 'true' }), text || btn.dataset.label);
    } else {
      if (btn.dataset.busy !== '1') return;           // idempotent: never restores a stale label
      btn.dataset.busy = '0';
      btn.disabled = false;
      btn.textContent = btn.dataset.label;
    }
  };

  /** RFC-4122 v4 UUID. crypto.randomUUID() only exists in secure (https) contexts, so fall back to getRandomValues. */
  PM.uuid = function () {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };

  /** Show / clear an inline error message element. */
  PM.showError = function (el, msg) {
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
  };
})();
