/* =====================================================================
   settings.js — Shop Settings: load/save (Supabase table shop_settings),
   logo + Facebook QR upload (Supabase Storage), label preview.
   Settings are shared by every phone logged into the account.
   ===================================================================== */
(function () {
  'use strict';
  const PM = window.PM;

  const TEXT_FIELDS = ['shop_name', 'tagline', 'sender_name', 'sender_mobile', 'sender_address', 'sender_village',
    'sender_post_office', 'sender_post_code', 'sender_thana', 'sender_district'];
  const NUM_FIELDS = ['label_width_mm', 'label_height_mm'];
  const PLACEHOLDER_NAME = 'Your Shop Name';

  const S = (PM.settings = {
    data: null,                       // current row of shop_settings
    assets: { logo: null, qr: null }, // decoded images for label rendering
    dirty: false,

    /* ---------- load ---------- */
    async load() {
      const { data, error } = await PM.db.from('shop_settings').select('*').eq('id', 1).maybeSingle();
      if (error) throw error;
      if (!data) throw new Error('Shop settings row is missing. Run supabase/schema.sql again.');
      this.data = data;
      await this.loadAssets();
      return data;
    },

    async loadAssets() {
      const d = this.data || {};
      const [logo, qr] = await Promise.all([
        PM.assets.load(d.logo_path).catch(() => null),
        PM.assets.load(d.qr_path).catch(() => null)
      ]);
      this.assets = { logo, qr };
      PM.assets.keepOnly([d.logo_path, d.qr_path]);
    },

    /** What is still missing from the shop setup (for the dashboard banner). */
    missing() {
      const d = this.data || {};
      const out = [];
      if (!d.shop_name || d.shop_name === PLACEHOLDER_NAME) out.push('shop name');
      if (!d.sender_mobile || /X/i.test(d.sender_mobile)) out.push('mobile number');
      if (!d.sender_address || d.sender_address === 'Your full shop address') out.push('address');
      if (!d.logo_path) out.push('logo');
      if (!d.qr_path) out.push('Facebook QR');
      return out;
    },

    /* ---------- save ---------- */
    read() {
      const v = {};
      TEXT_FIELDS.forEach((k) => { v[k] = (PM.$(`[data-field="${k}"]`).value || '').trim(); });
      v.sender_mobile = PM.toAsciiDigits(v.sender_mobile);
      v.sender_post_code = PM.toAsciiDigits(v.sender_post_code);
      NUM_FIELDS.forEach((k) => { v[k] = Number(PM.toAsciiDigits(PM.$(`[data-field="${k}"]`).value)); });
      return v;
    },

    validate(v) {
      const bad = [];
      ['shop_name', 'sender_name', 'sender_mobile', 'sender_address'].forEach((k) => { if (!v[k]) bad.push(k); });
      if (!(v.label_width_mm >= 40 && v.label_width_mm <= 300)) bad.push('label_width_mm');
      if (!(v.label_height_mm >= 40 && v.label_height_mm <= 400)) bad.push('label_height_mm');
      PM.$$('#settings-form [data-field]').forEach((el) => el.classList.toggle('invalid', bad.includes(el.dataset.field)));
      if (!bad.length) return '';
      if (bad.some((k) => k.startsWith('label_'))) return 'Label width must be 40–300 mm and height 40–400 mm.';
      return 'Please fill in the highlighted fields.';
    },

    async save(btn) {
      const v = this.read();
      const errEl = PM.$('#settings-error');
      const msg = this.validate(v);
      PM.showError(errEl, msg);
      if (msg) return;
      PM.setBusy(btn, true, 'Saving…');
      try {
        await PM.sync.track(async () => {
          const { data, error } = await PM.db.from('shop_settings').update(v).eq('id', 1).select().maybeSingle();
          if (error) throw error;
          if (!data) throw new Error('Settings were not saved (no permission). Log in again and retry.');
          this.data = data;
        });
        this.dirty = false;
        this.fill();
        PM.toast('Settings saved on all devices. / সেটিংস সেভ হয়েছে।', 'success');
      } catch (e) {
        PM.showError(errEl, 'Could not save: ' + PM.errMsg(e));
      } finally { PM.setBusy(btn, false); }
    },

    /* ---------- images ---------- */
    async detectType(file) {
      const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
      const is = (...b) => b.every((x, i) => head[i] === x);
      if (is(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { ext: 'png', mime: 'image/png' };
      if (is(0xff, 0xd8, 0xff)) return { ext: 'jpg', mime: 'image/jpeg' };
      const txt = (await file.slice(0, 4096).text()).replace(/^﻿/, '');
      if (/<svg[\s>]/i.test(txt)) return { ext: 'svg', mime: 'image/svg+xml' };
      return null;
    },

    async checkSvg(file) {
      const t = await file.text();
      if (/<script|<foreignObject|<iframe|<embed|<object|<!ENTITY|javascript:|\son[a-z]+\s*=/i.test(t)) {
        throw new Error('This SVG contains scripts or unsafe elements and was rejected.');
      }
      if (/(?:xlink:)?href\s*=\s*["']\s*(?!#|data:)[^"']/i.test(t)) {
        throw new Error('This SVG links to external files. Please export an SVG without external links.');
      }
    },

    async uploadImage(kind, file, btn) {
      const label = kind === 'logo' ? 'Logo' : 'QR image';
      try {
        if (!file) return;
        if (file.size > PM.config.MAX_IMAGE_BYTES) throw new Error(`${label} is larger than 2 MB. Please use a smaller file.`);
        const type = await this.detectType(file);
        if (!type) throw new Error('Only PNG, JPG and SVG images are allowed.');
        if (type.ext === 'svg') await this.checkSvg(file);
        PM.setBusy(btn, true, 'Uploading…');

        await PM.sync.track(async () => {
          const field = kind + '_path';
          const oldPath = this.data[field];
          const path = `${kind}-${Date.now()}.${type.ext}`;           // new name each time: no stale caches on other phones
          const up = await PM.db.storage.from(PM.config.STORAGE_BUCKET).upload(path, file, { contentType: type.mime, cacheControl: '31536000', upsert: false });
          if (up.error) throw up.error;
          const { data, error } = await PM.db.from('shop_settings').update({ [field]: path }).eq('id', 1).select().maybeSingle();
          if (error || !data) {
            await PM.db.storage.from(PM.config.STORAGE_BUCKET).remove([path]).catch(() => {});
            throw error || new Error('Could not save the new image.');
          }
          this.data = data;
          if (oldPath) PM.db.storage.from(PM.config.STORAGE_BUCKET).remove([oldPath]).catch(() => {});
        });
        await this.loadAssets();
        PM.setBusy(btn, false);
        this.fillImages();
        PM.toast(`${label} uploaded and synced to all devices. / আপলোড সম্পন্ন।`, 'success');
      } catch (e) {
        PM.toast(`${label}: ${PM.errMsg(e)}`, 'error', 7000);
      } finally { PM.setBusy(btn, false); }
    },

    async removeImage(kind) {
      const label = kind === 'logo' ? 'logo' : 'Facebook QR image';
      const ok = await PM.confirm({ title: `Remove ${label}?`, message: 'It will disappear from all labels (printed and new).', okText: 'Remove', danger: true });
      if (!ok) return;
      try {
        await PM.sync.track(async () => {
          const field = kind + '_path';
          const oldPath = this.data[field];
          const { data, error } = await PM.db.from('shop_settings').update({ [field]: null }).eq('id', 1).select().maybeSingle();
          if (error || !data) throw error || new Error('Could not remove the image.');
          this.data = data;
          if (oldPath) PM.db.storage.from(PM.config.STORAGE_BUCKET).remove([oldPath]).catch(() => {});
        });
        await this.loadAssets();
        this.fillImages();
        PM.toast('Image removed.', 'success');
      } catch (e) { PM.toast(PM.errMsg(e), 'error'); }
    },

    /* ---------- form binding ---------- */
    fill() {
      const d = this.data || {};
      TEXT_FIELDS.concat(NUM_FIELDS).forEach((k) => {
        const el = PM.$(`[data-field="${k}"]`);
        if (el) el.value = d[k] ?? '';
      });
      PM.$$('#settings-form .invalid').forEach((e) => e.classList.remove('invalid'));
      this.fillImages();
    },

    fillImages() {
      [['logo', 'logo-preview', 'No logo', 'logo-remove', 'logo-upload', 'Upload Logo', 'Change Logo'],
       ['qr', 'qr-preview', 'No QR image', 'qr-remove', 'qr-upload', 'Upload QR Image', 'Change QR Image']].forEach(([kind, boxId, empty, rmId, upId, upText, chText]) => {
        const box = PM.$('#' + boxId), a = this.assets[kind];
        if (a) box.replaceChildren(PM.el('img', { src: a.url, alt: kind }));
        else box.replaceChildren(PM.el('span', { class: 'muted small' }, empty));
        PM.$('#' + rmId).hidden = !a && !(this.data && this.data[kind + '_path']);
        PM.$('#' + upId).textContent = this.data && this.data[kind + '_path'] ? chText : upText;
      });
    },

    /** Called when another phone changed the settings. */
    onRemoteChange() {
      if (!PM.$('#page-settings').hidden && this.dirty) {
        PM.toast('Settings were changed on another device. Save to overwrite, or reload this page.', 'warn', 7000);
        this.fillImages();
        return;
      }
      this.fill();
    },

    preview() {
      const merged = Object.assign({}, this.data, this.read());
      const wrap = PM.el('div', { class: 'label-wrap' });
      const warn = PM.el('p', { class: 'form-error', hidden: true });
      PM.printer.renderPreview(wrap, PM.printer.sampleOrder(), merged, this.assets, warn);
      const close = PM.el('button', { class: 'btn primary', type: 'button', onclick: () => m.close() }, 'Close');
      const m = PM.modal([PM.el('h2', {}, 'Label Preview / লেবেল প্রিভিউ'),
        PM.el('p', { class: 'muted small' }, 'Sample customer data. Your real label uses the order you save.'),
        wrap, warn, PM.el('div', { class: 'actions-row' }, close)], { wide: true });
    },

    init() {
      const form = PM.$('#settings-form');
      form.addEventListener('submit', (e) => { e.preventDefault(); this.save(PM.$('#settings-save')); });
      form.addEventListener('input', (e) => { this.dirty = true; if (e.target.classList) e.target.classList.remove('invalid'); });
      PM.$('#settings-preview').addEventListener('click', () => this.preview());
      PM.$$('[data-size]').forEach((b) => b.addEventListener('click', () => {
        const [w, h] = b.dataset.size.split('x');
        PM.$('[data-field="label_width_mm"]').value = w;
        PM.$('[data-field="label_height_mm"]').value = h;
        this.dirty = true;
      }));
      ['logo', 'qr'].forEach((kind) => {
        const file = PM.$(`#${kind}-file`), up = PM.$(`#${kind}-upload`);
        up.addEventListener('click', () => file.click());
        file.addEventListener('change', async () => { const f = file.files[0]; file.value = ''; await this.uploadImage(kind, f, up); });
        PM.$(`#${kind}-remove`).addEventListener('click', () => this.removeImage(kind));
      });
    }
  });
})();
