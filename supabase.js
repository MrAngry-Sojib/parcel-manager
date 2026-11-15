/* =====================================================================
   supabase.js — Supabase client, connection/sync status, realtime.
   ===================================================================== */
(function () {
  'use strict';
  const PM = window.PM;
  const cfg = PM.config;

  PM.isConfigured = !/PASTE_/.test(cfg.SUPABASE_URL) && !/PASTE_/.test(cfg.SUPABASE_KEY);
  PM.db = null;
  if (PM.isConfigured && window.supabase && window.supabase.createClient) {
    PM.db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
    });
  }

  /* ---------- friendly error messages ---------- */
  PM.errMsg = function (e) {
    const m = (e && (e.message || e.error_description || e.msg)) || String(e || 'Unknown error');
    if (/failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(m) || !navigator.onLine) {
      return 'No connection to the server. Check your internet and try again.';
    }
    if (e && (e.code === '42501' || /row-level security|permission denied/i.test(m))) {
      return 'You do not have permission to do this. Make sure you are signed in with the shop account.';
    }
    if (/jwt (expired|invalid)|invalid jwt|refresh token/i.test(m)) return 'Your session expired. Please log in again.';
    return m;
  };

  /* ---------- connection / sync indicator ---------- */
  // States: ok (synced) | busy (saving) | warn (connecting) | bad (offline)
  const sync = (PM.sync = { rt: 'connecting', saving: 0 });

  function current() {
    if (!navigator.onLine) return { cls: 'bad', label: 'Offline' };
    if (sync.saving > 0) return { cls: 'busy', label: 'Saving…' };
    if (sync.rt === 'live') return { cls: 'ok', label: 'Synced' };
    if (sync.rt === 'error') return { cls: 'warn', label: 'Reconnecting…' };
    return { cls: 'warn', label: 'Connecting…' };
  }

  sync.update = function () {
    const badge = document.getElementById('sync-badge');
    if (!badge) return;
    const s = current();
    badge.className = 'sync ' + s.cls;
    badge.querySelector('span').textContent = s.label;
  };

  // Wrap any write so the badge shows "Saving…" while it runs.
  sync.track = async function (work) {
    sync.saving++; sync.update();
    try { return await (typeof work === 'function' ? work() : work); }
    finally { sync.saving--; sync.update(); }
  };

  window.addEventListener('online', sync.update);
  window.addEventListener('offline', sync.update);

  /* ---------- realtime: other phones' changes arrive instantly ---------- */
  PM.realtime = {
    channel: null,
    start(onChange) {
      if (!PM.db || this.channel) return;
      const ch = PM.db.channel('shop-sync');
      ['orders', 'order_items', 'shop_settings'].forEach((table) => {
        ch.on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => onChange(table, payload));
      });
      ch.subscribe((status) => {
        if (status === 'SUBSCRIBED') sync.rt = 'live';
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') sync.rt = 'error';
        else sync.rt = 'connecting';
        sync.update();
      });
      this.channel = ch;
    },
    stop() {
      if (this.channel && PM.db) PM.db.removeChannel(this.channel);
      this.channel = null; sync.rt = 'connecting'; sync.update();
    }
  };
})();
