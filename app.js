/* =====================================================================
   app.js — start-up, login screen, hash router, dashboard, realtime wiring.
   Routes: #dashboard  #new  #dup/<id>  #edit/<id>  #order/<id>  #orders  #settings  #account
   ===================================================================== */
(function () {
  'use strict';
  const PM = window.PM;
  const show = (id, on = true) => { const n = PM.$('#' + id); if (n) n.hidden = !on; };

  let routeToken = 0;         // ignore results of an outdated route
  let refreshCurrent = null;  // re-load the visible page (used by realtime / sync button)
  let started = false;

  /* ---------------- navigation helpers ---------------- */
  const PAGES = ['dashboard', 'order-form', 'order', 'orders', 'settings', 'account'];
  function showPage(name, nav) {
    PAGES.forEach((p) => show('page-' + p, p === name));
    PM.$$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));
    window.scrollTo(0, 0);
  }

  function showBrand() {
    const d = PM.settings.data;
    PM.$('#brand-name').textContent = (d && d.shop_name) || 'Parcel Manager';
  }

  /* ---------------- pages ---------------- */
  async function pageDashboard(token) {
    showPage('dashboard', 'dashboard');
    const miss = PM.settings.missing();
    show('setup-banner', miss.length > 0);
    PM.$('#setup-banner-text').textContent = miss.length ? 'Still to add: ' + miss.join(', ') + '.' : '';
    const load = async () => {
      try {
        const [stats, recent] = await Promise.all([PM.orders.stats(), PM.orders.recent(5)]);
        if (token !== routeToken) return;
        PM.$('#stat-total').textContent = stats.total;
        PM.$('#stat-today').textContent = stats.today;
        PM.orders.renderList(PM.$('#recent-list'), recent);
      } catch (e) {
        if (token !== routeToken) return;
        PM.$('#recent-list').replaceChildren(PM.el('div', { class: 'form-error' }, 'Could not load: ' + PM.errMsg(e)));
      }
    };
    refreshCurrent = () => { show('setup-banner', PM.settings.missing().length > 0); return load(); };
    PM.$('#recent-list').replaceChildren(PM.el('div', { class: 'empty' }, PM.el('span', { class: 'spinner big' })));
    await load();
  }

  function pageNew() {
    showPage('order-form', 'new');
    PM.orders.form.open('new');
    refreshCurrent = () => PM.orders.form.refresh();
  }

  async function pageFromOrder(mode, id, token) {
    showPage('order-form', mode === 'edit' ? 'orders' : 'new');
    refreshCurrent = null;
    try {
      const o = await PM.orders.get(id);
      if (token !== routeToken) return;
      if (!o) { PM.toast('Order not found.', 'error'); location.hash = '#orders'; return; }
      PM.orders.form.open(mode, o);
      refreshCurrent = () => PM.orders.form.refresh();
    } catch (e) {
      if (token !== routeToken) return;
      PM.toast('Could not load the order: ' + PM.errMsg(e), 'error'); location.hash = '#orders';
    }
  }

  async function pageOrder(id, token) {
    showPage('order', 'orders');
    const load = async (silent) => {
      try {
        const o = await PM.orders.get(id);
        if (token !== routeToken) return;
        if (!o) { PM.toast('This order no longer exists (deleted on another device?).', 'warn'); location.hash = '#orders'; return; }
        PM.orders.detail.show(o);
      } catch (e) {
        if (token !== routeToken) return;
        if (!silent) { PM.toast('Could not load the order: ' + PM.errMsg(e), 'error'); location.hash = '#orders'; }
      }
    };
    PM.orders.detail.order = null;
    refreshCurrent = () => load(true);
    await load(false);
  }

  function pageOrders() {
    showPage('orders', 'orders');
    const h = PM.orders.history;
    refreshCurrent = () => h.reload(true);
    return h.reload();
  }

  function pageSettings() {
    showPage('settings', 'settings');
    PM.settings.dirty = false;
    PM.settings.fill();
    PM.showError(PM.$('#settings-error'), '');
    refreshCurrent = () => PM.settings.onRemoteChange();
  }

  function pageAccount() {
    showPage('account', 'account');
    PM.$('#acct-email').textContent = (PM.auth.user && PM.auth.user.email) || '–';
    refreshCurrent = null;
  }

  /* ---------------- router ---------------- */
  async function route() {
    if (!PM.auth.user) return;
    const token = ++routeToken;
    const [name, arg] = (location.hash.replace(/^#/, '') || 'dashboard').split('/');
    switch (name) {
      case 'dashboard': return pageDashboard(token);
      case 'new': return pageNew();
      case 'dup': return arg ? pageFromOrder('dup', arg, token) : (location.hash = '#new');
      case 'edit': return arg ? pageFromOrder('edit', arg, token) : (location.hash = '#orders');
      case 'order': return arg ? pageOrder(arg, token) : (location.hash = '#orders');
      case 'orders': return pageOrders();
      case 'settings': return pageSettings();
      case 'account': return pageAccount();
      default: location.hash = '#dashboard';
    }
  }

  /* ---------------- realtime: another phone changed something ---------------- */
  const onRemoteChange = PM.debounce(async (table) => {
    try {
      if (table === 'shop_settings') {
        await PM.settings.load();
        showBrand();
        PM.orders.detail.preview();
        if (!PM.$('#page-order-form').hidden) PM.orders.form.refresh();
      }
      if (refreshCurrent) await refreshCurrent();
    } catch (e) { /* the status badge shows connectivity problems */ }
  }, 500);

  /* ---------------- session start / end ---------------- */
  async function startSession() {
    show('boot', true); show('view-login', false);
    try {
      await PM.settings.load();
      PM.label.ensureFonts();
    } catch (e) {
      show('boot', false); show('view-login', true);
      PM.showError(PM.$('#login-error'), 'Signed in, but the shop data could not be loaded: ' + PM.errMsg(e) + ' (Did you run supabase/schema.sql?)');
      return;
    }
    showBrand();
    show('boot', false); show('app', true);
    PM.sync.update();
    PM.realtime.start(onRemoteChange);
    started = true;
    if (!location.hash) location.hash = '#dashboard'; else route();
  }

  function endSession() {
    PM.realtime.stop();
    started = false; refreshCurrent = null; routeToken++;
    PM.orders.detail.order = null;
    show('app', false); show('boot', false); show('view-login', true);
    PM.$('#login-password').value = '';
    location.hash = '';
  }

  /* ---------------- boot ---------------- */
  async function boot() {
    if (!PM.isConfigured) { show('boot', false); show('setup-warning', true); return; }
    if (!PM.db) {
      show('boot', false);
      PM.$('#setup-warning .card').replaceChildren(PM.el('h1', {}, 'Could not start'),
        PM.el('p', {}, 'The Supabase library failed to load. Check your internet connection and reload the page.'));
      show('setup-warning', true); return;
    }

    PM.settings.init();
    PM.orders.init();
    window.addEventListener('hashchange', () => { if (started) route(); });
    PM.$('#sync-badge').addEventListener('click', async () => {
      if (!started) return;
      try { await PM.settings.load(); showBrand(); if (refreshCurrent) await refreshCurrent(); PM.toast('Refreshed.', 'success', 1500); }
      catch (e) { PM.toast(PM.errMsg(e), 'error'); }
    });
    PM.$('#btn-logout').addEventListener('click', async () => {
      try { await PM.auth.signOut(); } catch (e) { /* ignore */ }
      endSession();
    });

    PM.$('#dash-search').addEventListener('submit', (e) => {
      e.preventDefault();
      PM.orders.history.setQuery(PM.$('#dash-search-input').value);
      PM.orders.history.filters = PM.orders.history.readFilters();
      PM.$('#dash-search-input').value = '';
      if (location.hash === '#orders') route(); else location.hash = '#orders';
    });

    const form = PM.$('#login-form'), errEl = PM.$('#login-error'), btn = PM.$('#login-submit');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = PM.$('#login-email').value.trim(), pass = PM.$('#login-password').value;
      if (!email || !pass) { PM.showError(errEl, 'Enter your email and password.'); return; }
      PM.showError(errEl, ''); PM.setBusy(btn, true, 'Signing in…');
      try { await PM.auth.signIn(email, pass); await startSession(); }
      catch (err) { PM.showError(errEl, PM.errMsg(err)); }
      finally { PM.setBusy(btn, false); }
    });

    PM.auth.onSignedOut(() => { if (started) endSession(); });

    try {
      const user = await PM.auth.restore();
      if (user) await startSession(); else { show('boot', false); show('view-login', true); }
    } catch (e) {
      show('boot', false); show('view-login', true);
      PM.showError(errEl, PM.errMsg(e));
    }
  }

  boot();
})();
