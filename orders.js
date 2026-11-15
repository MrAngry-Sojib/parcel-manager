/* =====================================================================
   orders.js — orders: data access (Supabase), order form, history, details, CSV.
   All writes go through the database functions create_order / update_order,
   so the Order ID is always created by the database and can never be changed.
   ===================================================================== */
(function () {
  'use strict';
  const PM = window.PM;
  const SELECT = '*, order_items(product_name, quantity, position)';
  const O = (PM.orders = {});

  /* ================= data layer ================= */
  function norm(row) {
    if (!row) return row;
    if (row.items) return row;                               // already normalised (RPC result)
    const items = (row.order_items || []).slice().sort((a, b) => a.position - b.position)
      .map((i) => ({ product_name: i.product_name, quantity: i.quantity }));
    const { order_items, ...rest } = row;
    return { ...rest, items };
  }

  function applyFilters(qb, f) {
    if (f.q) {
      const q = PM.toAsciiDigits(f.q).replace(/[,()%*\\"'.:]/g, ' ').trim();
      if (q) qb = qb.or(`order_id.ilike.%${q}%,customer_name.ilike.%${q}%,mobile.ilike.%${q}%`);
    }
    if (f.from) qb = qb.gte('created_at', new Date(f.from + 'T00:00:00').toISOString());
    if (f.to) { const d = new Date(f.to + 'T00:00:00'); d.setDate(d.getDate() + 1); qb = qb.lt('created_at', d.toISOString()); }
    return qb;
  }

  O.stats = async function () {
    const today = PM.startOfLocalDay().toISOString();
    const [a, b] = await Promise.all([
      PM.db.from('orders').select('id', { count: 'exact', head: true }),
      PM.db.from('orders').select('id', { count: 'exact', head: true }).gte('created_at', today)
    ]);
    if (a.error) throw a.error;
    if (b.error) throw b.error;
    return { total: a.count || 0, today: b.count || 0 };
  };

  O.recent = async function (n = 5) {
    const { data, error } = await PM.db.from('orders').select(SELECT).order('created_at', { ascending: false }).limit(n);
    if (error) throw error;
    return data.map(norm);
  };

  O.list = async function (filters, offset, size) {
    let qb = PM.db.from('orders').select(SELECT, { count: 'exact' });
    qb = applyFilters(qb, filters).order('created_at', { ascending: false }).range(offset, offset + size - 1);
    const { data, error, count } = await qb;
    if (error) throw error;
    return { rows: data.map(norm), total: count || 0 };
  };

  O.get = async function (id) {
    const { data, error } = await PM.db.from('orders').select(SELECT).eq('id', id).maybeSingle();
    if (error) throw error;
    return norm(data);
  };

  O.create = (order, items, requestId) => PM.sync.track(async () => {
    const { data, error } = await PM.db.rpc('create_order', { p_order: order, p_items: items, p_request_id: requestId });
    if (error) throw error;
    return norm(data);
  });

  O.update = (id, order, items) => PM.sync.track(async () => {
    const { data, error } = await PM.db.rpc('update_order', { p_id: id, p_order: order, p_items: items });
    if (error) throw error;
    return norm(data);
  });

  O.remove = (id) => PM.sync.track(async () => {
    const { data, error } = await PM.db.from('orders').delete().eq('id', id).select('id');
    if (error) throw error;
    if (!data || !data.length) throw new Error('Order was not deleted (already removed or no permission).');
  });

  /* ================= CSV export ================= */
  function csvCell(v) {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;                  // block spreadsheet formula injection
    return '"' + s.replace(/"/g, '""') + '"';
  }

  O.exportCsv = async function (filters) {
    const rows = [];
    for (let off = 0; ; off += 500) {
      const { rows: part, total } = await O.list(filters, off, 500);
      rows.push(...part);
      if (rows.length >= total || !part.length) break;
    }
    if (!rows.length) throw new Error('There are no orders to export.');
    const head = ['Order ID', 'Date', 'Customer Name', 'Mobile', 'Village / Area', 'Post Office', 'Post Code', 'Thana / Upazila', 'District', 'Products'];
    const lines = [head.map(csvCell).join(',')];
    rows.forEach((o) => lines.push([
      o.order_id, PM.fmtDateTime(o.created_at), o.customer_name, o.mobile, o.village, o.post_office, o.post_code, o.thana, o.district,
      o.items.map((i) => `${i.product_name} x ${i.quantity}`).join('; ')
    ].map(csvCell).join(',')));
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const name = `orders-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.csv`;
    PM.printer.download(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), name);   // BOM: Excel shows Bangla correctly
    return rows.length;
  };

  /* ================= list rendering ================= */
  O.renderList = function (container, orders, emptyText) {
    if (!orders.length) {
      container.replaceChildren(PM.el('div', { class: 'empty' }, emptyText || 'No orders yet. / কোনো অর্ডার নেই।'));
      return;
    }
    container.replaceChildren(...orders.map((o) => PM.el('a', { class: 'order-item', href: '#order/' + o.id },
      PM.el('div', { class: 'row' }, PM.el('span', { class: 'oid mono' }, o.order_id), PM.el('span', { class: 'meta' }, PM.fmtDateTime(o.created_at))),
      PM.el('div', {}, o.customer_name, ' · ', o.mobile),
      PM.el('div', { class: 'meta' }, [o.district, `${o.items.length} product${o.items.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ')))));
  };

  /* ================= ORDER FORM (new / edit / duplicate) ================= */
  const F = (O.form = {
    mode: 'new', editId: null, orderId: null, requestId: null, saving: false, rendering: 0,

    init() {
      PM.$('#btn-add-item').addEventListener('click', () => { this.addRow(); this.refresh(); });
      PM.$('#order-form').addEventListener('submit', (e) => { e.preventDefault(); this.save(); });
      PM.$('#order-form').addEventListener('input', (e) => { if (e.target.classList) e.target.classList.remove('invalid'); });
      PM.$('#order-form').addEventListener('input', PM.debounce(() => this.refresh(), 150));
      PM.$('#btn-cancel-order').addEventListener('click', () => { location.hash = this.editId ? '#order/' + this.editId : '#dashboard'; });
    },

    /** order: optional prefill. mode: new | edit | dup */
    open(mode, order) {
      this.mode = mode;
      this.editId = mode === 'edit' ? order.id : null;
      this.orderId = mode === 'edit' ? order.order_id : null;
      this.requestId = PM.uuid();                  // one id per "Save" intent => retries can never duplicate
      this.saving = false;
      PM.$('#order-form').reset();
      PM.$$('#order-form .invalid').forEach((e) => e.classList.remove('invalid'));
      PM.showError(PM.$('#form-error'), ''); PM.showError(PM.$('#items-error'), '');
      PM.$('#items').replaceChildren();

      const titles = { new: 'New Order <small>নতুন অর্ডার</small>', edit: 'Edit Order <small>অর্ডার এডিট</small>', dup: 'Duplicate Order <small>অর্ডার ডুপ্লিকেট</small>' };
      PM.$('#form-title').innerHTML = titles[mode];
      PM.$('#btn-save-order').textContent = mode === 'edit' ? 'Save Changes' : 'Save Order';
      PM.$('#form-status').className = 'chip ' + (mode === 'edit' ? 'ok' : 'warn');
      PM.$('#form-status').textContent = mode === 'edit' ? 'Editing · ' + order.order_id : 'Not Saved';

      if (order) {
        ['customer_name', 'mobile', 'village', 'post_office', 'post_code', 'thana', 'district']
          .forEach((k) => { PM.$(`[data-o="${k}"]`).value = order[k] || ''; });
        (order.items.length ? order.items : [{ product_name: '', quantity: 1 }]).forEach((i) => this.addRow(i));
      } else this.addRow();
      if (mode === 'dup') PM.toast('Duplicated. A brand-new Order ID is created when you save.', 'info');
      this.refresh();
    },

    addRow(item) {
      const rows = PM.$('#items');
      const name = PM.el('input', { 'data-i': 'name', maxlength: 200, placeholder: 'e.g. Kids Toy Car', required: true, 'aria-label': 'Product name' });
      // type=text (not number) so Bangla digits can be typed; they are converted to 0-9 when read
      const qty = PM.el('input', { 'data-i': 'qty', type: 'text', inputmode: 'numeric', maxlength: 4, value: 1, autocomplete: 'off', 'aria-label': 'Quantity' });
      if (item) { name.value = item.product_name; qty.value = item.quantity; }
      const rm = PM.el('button', { class: 'btn danger', type: 'button', title: 'Remove product', 'aria-label': 'Remove product', onclick: () => { row.remove(); this.syncRemoveButtons(); this.refresh(); } }, '✕');
      const row = PM.el('div', { class: 'item-row' },
        PM.el('label', { class: 'field' }, PM.el('span', {}, 'Product Name / পণ্যের নাম'), name),
        PM.el('label', { class: 'field' }, PM.el('span', {}, 'Qty'), qty), rm);
      rows.append(row);
      this.syncRemoveButtons();
      if (!item) name.focus({ preventScroll: false });
    },

    syncRemoveButtons() {
      const rows = PM.$$('#items .item-row');
      rows.forEach((r) => { PM.$('button', r).disabled = rows.length === 1; });
    },

    read() {
      const g = (k) => PM.$(`[data-o="${k}"]`).value.trim();
      const order = {
        customer_name: g('customer_name'), mobile: PM.toAsciiDigits(g('mobile')), village: g('village'),
        post_office: g('post_office'), post_code: PM.toAsciiDigits(g('post_code')), thana: g('thana'), district: g('district')
      };
      const items = PM.$$('#items .item-row').map((r) => ({
        product_name: PM.$('[data-i="name"]', r).value.trim(),
        quantity: parseInt(PM.toAsciiDigits(PM.$('[data-i="qty"]', r).value), 10)
      }));
      return { order, items };
    },

    validate({ order, items }) {
      let bad = 0;
      PM.$$('#order-form [data-o]').forEach((el) => {
        let invalid = !order[el.dataset.o];
        if (el.dataset.o === 'mobile' && order.mobile) {
          const digits = order.mobile.replace(/\D/g, '');
          invalid = digits.length < 10 || digits.length > 15;
        }
        el.classList.toggle('invalid', invalid);
        if (invalid) bad++;
      });
      let itemBad = 0;
      PM.$$('#items .item-row').forEach((r, i) => {
        const nameBad = !items[i].product_name;
        const qtyBad = !(items[i].quantity >= 1 && items[i].quantity <= 9999);
        PM.$('[data-i="name"]', r).classList.toggle('invalid', nameBad);
        PM.$('[data-i="qty"]', r).classList.toggle('invalid', qtyBad);
        if (nameBad || qtyBad) itemBad++;
      });
      PM.showError(PM.$('#items-error'), itemBad ? 'Every product needs a name and a quantity from 1 to 9999.' : '');
      const mobBad = PM.$('[data-o="mobile"]').classList.contains('invalid') && order.mobile;
      if (bad || itemBad) return mobBad ? 'Please check the mobile number (10–15 digits) and the highlighted fields.' : 'Please fill in all highlighted fields. / হাইলাইট করা ঘরগুলো পূরণ করুন।';
      return '';
    },

    refresh() {
      const { order, items } = this.read();
      const view = { ...order, items: items.map((i) => ({ product_name: i.product_name, quantity: Number.isFinite(i.quantity) ? i.quantity : '' })), order_id: this.orderId, created_at: null };
      PM.printer.renderPreview(PM.$('#form-preview'), view, PM.settings.data, PM.settings.assets, PM.$('#form-preview-warn'));
    },

    async save() {
      if (this.saving) return;                               // blocks double taps
      const data = this.read();
      const errEl = PM.$('#form-error');
      const msg = this.validate(data);
      PM.showError(errEl, msg);
      if (msg) { const first = PM.$('#order-form .invalid'); if (first) first.focus(); return; }

      this.saving = true;
      const btn = PM.$('#btn-save-order');
      PM.setBusy(btn, true, 'Saving…');
      try {
        const saved = this.mode === 'edit'
          ? await O.update(this.editId, data.order, data.items)
          : await O.create(data.order, data.items, this.requestId);
        this.requestId = PM.uuid();
        PM.toast(this.mode === 'edit' ? 'Order updated. / আপডেট হয়েছে।' : `Order saved: ${saved.order_id} / অর্ডার সেভ হয়েছে`, 'success');
        location.hash = '#order/' + saved.id;
      } catch (e) {
        // The order is NOT shown as saved. Retrying uses the same request id, so it can never create a duplicate.
        PM.showError(errEl, 'Not saved. ' + PM.errMsg(e) + (this.mode === 'edit' ? '' : ' You can safely press Save again.'));
        PM.$('#form-status').className = 'chip warn';
        PM.$('#form-status').textContent = this.mode === 'edit' ? 'Changes not saved' : 'Not Saved';
      } finally {
        this.saving = false;
        PM.setBusy(btn, false);
      }
    }
  });

  /* ================= ORDER DETAILS ================= */
  O.detail = {
    order: null,
    init() {
      const run = (btn, text, fn) => async () => {
        if (!this.order) return;
        PM.setBusy(btn, true, text);
        try { await fn(this.order); } catch (e) { PM.toast(PM.errMsg(e), 'error', 8000); } finally { PM.setBusy(btn, false); }
      };
      const print = PM.$('#od-print'), pdf = PM.$('#od-pdf');
      print.addEventListener('click', run(print, 'Preparing…', (o) => PM.printer.print(o, PM.settings.data)));
      pdf.addEventListener('click', run(pdf, 'Building PDF…', async (o) => {
        await PM.printer.downloadPdf(o, PM.settings.data);
        PM.toast(`${o.order_id}.pdf downloaded`, 'success');
      }));
      PM.$('#od-edit').addEventListener('click', () => { if (this.order) location.hash = '#edit/' + this.order.id; });
      PM.$('#od-dup').addEventListener('click', () => { if (this.order) location.hash = '#dup/' + this.order.id; });
      const del = PM.$('#od-del');
      del.addEventListener('click', async () => {
        const o = this.order; if (!o) return;
        const ok = await PM.confirm({ title: 'Delete this order?', message: `${o.order_id} (${o.customer_name}) will be permanently deleted. This cannot be undone. / অর্ডারটি স্থায়ীভাবে মুছে যাবে।`, okText: 'Delete', danger: true });
        if (!ok) return;
        PM.setBusy(del, true, 'Deleting…');
        try { await O.remove(o.id); PM.toast('Order deleted.', 'success'); location.hash = '#orders'; }
        catch (e) { PM.toast(PM.errMsg(e), 'error'); } finally { PM.setBusy(del, false); }
      });
    },

    show(order) {
      this.order = order;
      PM.$('#od-id').textContent = order.order_id;
      PM.$('#od-date').textContent = PM.fmtDateTime(order.created_at);
      const rows = [['Customer', order.customer_name], ['Mobile', order.mobile], ['Village / Area', order.village], ['Post Office', order.post_office],
        ['Post Code', order.post_code], ['Thana / Upazila', order.thana], ['District', order.district]];
      PM.$('#od-details').replaceChildren(...rows.flatMap(([k, v]) => [PM.el('dt', {}, k), PM.el('dd', {}, v)]));
      PM.$('#od-items tbody').replaceChildren(...order.items.map((i) => PM.el('tr', {}, PM.el('td', {}, i.product_name), PM.el('td', { class: 'num' }, i.quantity))));
      this.preview();
    },

    preview() {
      if (!this.order) return;
      PM.printer.renderPreview(PM.$('#od-preview'), this.order, PM.settings.data, PM.settings.assets, PM.$('#od-preview-warn'));
    }
  };

  /* ================= ORDER HISTORY ================= */
  O.history = {
    filters: { q: '', from: '', to: '' }, rows: [], total: 0, busy: false, token: 0,

    init() {
      const form = PM.$('#orders-filter');
      form.addEventListener('submit', (e) => { e.preventDefault(); this.apply(); });
      PM.$('#f-clear').addEventListener('click', () => { form.reset(); this.apply(); });
      PM.$('#orders-more').addEventListener('click', () => this.more());
      const csv = PM.$('#f-csv');
      csv.addEventListener('click', async () => {
        PM.setBusy(csv, true, 'Exporting…');
        try { const n = await O.exportCsv(this.readFilters()); PM.toast(`${n} orders exported.`, 'success'); }
        catch (e) { PM.toast(PM.errMsg(e), 'error'); } finally { PM.setBusy(csv, false); }
      });
    },

    readFilters() { return { q: PM.$('#f-q').value.trim(), from: PM.$('#f-from').value, to: PM.$('#f-to').value }; },
    setQuery(q) { PM.$('#f-q').value = q || ''; },

    apply() { this.filters = this.readFilters(); return this.reload(); },

    async reload(silent) {
      const token = ++this.token, list = PM.$('#orders-list');
      if (!silent) list.replaceChildren(PM.el('div', { class: 'empty' }, PM.el('span', { class: 'spinner big' })));
      try {
        // on a silent refresh keep as many rows as are already on screen
        const size = silent ? Math.max(PM.config.PAGE_SIZE, this.rows.length) : PM.config.PAGE_SIZE;
        const { rows, total } = await O.list(this.filters, 0, size);
        if (token !== this.token) return;
        this.rows = rows; this.total = total; this.draw();
      } catch (e) {
        if (token !== this.token) return;
        list.replaceChildren(PM.el('div', { class: 'form-error' }, 'Could not load orders: ' + PM.errMsg(e)));
      }
    },

    async more() {
      const btn = PM.$('#orders-more'); PM.setBusy(btn, true, 'Loading…');
      try {
        const { rows, total } = await O.list(this.filters, this.rows.length, PM.config.PAGE_SIZE);
        const seen = new Set(this.rows.map((r) => r.id));
        this.rows = this.rows.concat(rows.filter((r) => !seen.has(r.id))); this.total = total; this.draw();
      } catch (e) { PM.toast(PM.errMsg(e), 'error'); } finally { PM.setBusy(btn, false); }
    },

    draw() {
      const f = this.filters, filtered = f.q || f.from || f.to;
      O.renderList(PM.$('#orders-list'), this.rows, filtered ? 'No orders match your search. / কিছু পাওয়া যায়নি।' : 'No orders yet. Create your first order! / এখনো কোনো অর্ডার নেই।');
      PM.$('#orders-count').textContent = this.total ? `Showing ${this.rows.length} of ${this.total}` : '';
      PM.$('#orders-more').hidden = this.rows.length >= this.total;
    }
  };

  O.init = function () { F.init(); O.detail.init(); O.history.init(); };
})();
