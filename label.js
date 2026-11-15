/* =====================================================================
   label.js — the parcel label.

   ONE layout engine decides where every text, line and image goes
   (all coordinates in millimetres). The same list of items is then drawn:
     * as an inline SVG  -> on-screen preview AND the browser print dialog
                            (vector text, stays sharp on thermal printers)
     * onto a <canvas>   -> for the PDF (see printer.js)
   so preview, print and PDF always look the same.

   Layout is based on a 100 x 150 mm design and scales to any label size set in
   Shop Settings. If the content is too tall (many products) the text is shrunk
   automatically; if it still cannot fit, `layout.fits` is false and the UI warns.
   ===================================================================== */
(function () {
  'use strict';
  const PM = window.PM;
  const L = (PM.label = {});

  const GREEN = '#0b4f2f';
  const INK = '#111111';
  const FONT = '"Noto Sans","Noto Sans Bengali","Hind Siliguri","Nirmala UI","Vrinda",system-ui,sans-serif';
  L.FONT = FONT;

  /* ---------------------------------------------------------------
     Fonts
     --------------------------------------------------------------- */
  L.ensureFonts = async function () {
    if (!document.fonts || !document.fonts.load) return;
    const jobs = [];
    ['400', '600', '700', '800'].forEach((w) => {
      jobs.push(document.fonts.load(`${w} 16px "Noto Sans"`, 'SP-BW 0123 Aa'));
      jobs.push(document.fonts.load(`${w} 16px "Noto Sans Bengali"`, 'প্রেরক প্রাপক পণ্য'));
    });
    try {
      await Promise.race([Promise.allSettled(jobs), new Promise((r) => setTimeout(r, 5000))]);
      await document.fonts.ready;
    } catch (e) { /* fall back to system fonts */ }
    mcache.clear();
  };

  /* ---------------------------------------------------------------
     Text measuring / wrapping (canvas measureText = same shaping as the browser draws)
     --------------------------------------------------------------- */
  const mcache = new Map();
  const mctx = document.createElement('canvas').getContext('2d');

  /** width of `text` per 1 unit of font-size */
  function unitW(text, weight) {
    const key = weight + '|' + text;
    let v = mcache.get(key);
    if (v === undefined) {
      mctx.font = `${weight} 100px ${FONT}`;
      v = mctx.measureText(text).width / 100;
      if (mcache.size > 5000) mcache.clear();
      mcache.set(key, v);
    }
    return v;
  }

  const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  const graphemes = (s) => (seg ? Array.from(seg.segment(s), (x) => x.segment) : Array.from(s));

  function ellipsize(text, weight, size, maxW) {
    if (unitW(text, weight) * size <= maxW) return text;
    const g = graphemes(text);
    while (g.length > 1 && unitW(g.join('') + '…', weight) * size > maxW) g.pop();
    return g.join('') + '…';
  }

  function fitSize(text, weight, maxSize, maxW, minSize) {
    const w = unitW(text, weight) * maxSize;
    if (w <= maxW) return maxSize;
    return Math.max(minSize, (maxSize * maxW) / w);
  }

  /** Word-wrap into at most maxLines lines (breaks very long words by character). */
  function wrap(text, weight, size, maxW, maxLines) {
    const w = (t) => unitW(t, weight) * size;
    const lines = [];
    let cur = '';
    for (const word of String(text).split(/\s+/).filter(Boolean)) {
      const cand = cur ? cur + ' ' + word : word;
      if (w(cand) <= maxW) { cur = cand; continue; }
      if (cur) { lines.push(cur); cur = ''; }
      if (w(word) <= maxW) { cur = word; continue; }
      let chunk = '';
      for (const g of graphemes(word)) {
        if (chunk && w(chunk + g) > maxW) { lines.push(chunk); chunk = g; } else chunk += g;
      }
      cur = chunk;
    }
    if (cur) lines.push(cur);
    if (!lines.length) lines.push('');
    if (lines.length > maxLines) {
      lines.length = maxLines;
      lines[maxLines - 1] = ellipsize(lines[maxLines - 1] + '…', weight, size, maxW);
    }
    return lines;
  }

  function fitRect(asset, x, y, w, h) {
    const sc = Math.min(w / asset.w, h / asset.h);
    const nw = asset.w * sc, nh = asset.h * sc;
    return { x: x + (w - nw) / 2, y: y + (h - nh) / 2, w: nw, h: nh };
  }

  /* ---------------------------------------------------------------
     Data -> label content
     --------------------------------------------------------------- */
  L.dims = function (settings) {
    const d = PM.config.DEFAULT_LABEL_MM;
    const W = Number(settings && settings.label_width_mm) || d.w;
    const H = Number(settings && settings.label_height_mm) || d.h;
    return { W, H };
  };

  /**
   * order  : { order_id|null, customer_name, mobile, village, post_office, post_code, thana, district, items:[{product_name, quantity}], created_at }
   * assets : { logo, qr }  (objects from PM.assets.load, or null)
   */
  L.makeData = function (order, settings, assets, preview) {
    const st = settings || {};
    const o = order || {};
    const clean = (v) => (v == null ? '' : String(v).trim());
    const or = (v) => clean(v) || (preview ? '—' : '');
    const po = clean(st.sender_post_office);
    const code = clean(st.sender_post_code);
    const extra = [clean(st.sender_village), po && code ? `${po} - ${code}` : po || code, clean(st.sender_thana), clean(st.sender_district)]
      .filter(Boolean).join(', ');
    return {
      shopName: clean(st.shop_name) || 'Your Shop Name',
      tagline: clean(st.tagline),
      logo: (assets && assets.logo) || null,
      qr: (assets && assets.qr) || null,
      sender: { name: clean(st.sender_name) || clean(st.shop_name), mobile: clean(st.sender_mobile), address: clean(st.sender_address), extra },
      to: {
        name: or(o.customer_name), mobile: or(o.mobile), village: or(o.village), po: or(o.post_office),
        code: or(o.post_code), thana: or(o.thana), district: or(o.district)
      },
      items: (o.items || []).filter((i) => clean(i.product_name) || preview).map((i) => ({ name: clean(i.product_name) || '—', qty: i.quantity || '' })),
      orderId: clean(o.order_id) || null,
      dateStr: o.created_at ? PM.fmtDay(o.created_at) : ''
    };
  };

  /* ---------------------------------------------------------------
     The layout engine
     --------------------------------------------------------------- */
  L.layout = function (d, opts) {
    const W = opts.W, H = opts.H;
    const s = Math.min(W / 100, H / 150);
    let last = null;
    for (let f = 1; f >= 0.5; f -= 0.04) {
      last = build(d, W, H, s, f, !!opts.preview);
      if (last.fits) return last;
    }
    return last;                                      // fits === false
  };

  function build(d, W, H, s, f, preview) {
    const items = [];
    const rect = (x, y, w, h, o = {}) => items.push({ t: 'rect', x, y, w, h, stroke: o.stroke || null, sw: o.sw || 0, fill: o.fill || null, dash: o.dash || null });
    const line = (x1, y1, x2, y2, sw, c = GREEN) => items.push({ t: 'line', x1, y1, x2, y2, sw, c });
    const text = (str, x, y, size, weight, color, anchor = 'start') => items.push({ t: 'text', text: str, x, y, size, weight, color, anchor });
    const baseline = (top, lh, size) => top + lh / 2 + 0.36 * size;     // vertical-centre text in a line box

    const m = 2.2 * s, pad = 2.2 * s, lw = 0.3 * s;
    const x0 = m, y0 = m, x1 = W - m, y1 = H - m;
    const left = x0 + pad, right = x1 - pad, innerW = right - left;

    rect(x0, y0, x1 - x0, y1 - y0, { stroke: GREEN, sw: 0.55 * s });

    /* ---------- header: logo + shop name + tagline | SPEED POST ---------- */
    let y = y0;
    const headH = 15.5 * s, lg = 11.5 * s;
    let tx = left;
    if (d.logo) {
      const r = fitRect(d.logo, left, y + (headH - lg) / 2, lg, lg);
      items.push({ t: 'img', role: 'logo', asset: d.logo, ...r });
      tx = left + lg + 2 * s;
    } else if (preview) {
      rect(left, y + (headH - lg) / 2, lg, lg, { stroke: '#9ca3af', sw: 0.3 * s, dash: [s, s] });
      text('LOGO', left + lg / 2, y + headH / 2 + 0.8 * s, 2.2 * s, 600, '#9ca3af', 'middle');
      tx = left + lg + 2 * s;
    }
    const spSize = 3.5 * s;
    const spW = unitW('SPEED POST', 800) * spSize + 5 * s, spH = 7.4 * s;
    const spX = right - spW, spY = y + (headH - spH) / 2;
    rect(spX, spY, spW, spH, { stroke: GREEN, sw: 0.55 * s });
    text('SPEED POST', spX + spW / 2, baseline(spY, spH, spSize), spSize, 800, GREEN, 'middle');

    const bw = spX - 2 * s - tx;
    const nameSize = fitSize(d.shopName, 800, 4.8 * s, bw, 2.4 * s);
    const tagSize = fitSize(d.tagline || ' ', 600, 2.5 * s, bw, 1.6 * s);
    const blockH = nameSize * 1.15 + (d.tagline ? tagSize * 1.3 : 0);
    const by = y + (headH - blockH) / 2;
    text(ellipsize(d.shopName, 800, nameSize, bw), tx, by + nameSize * 0.95, nameSize, 800, INK);
    if (d.tagline) text(ellipsize(d.tagline, 600, tagSize, bw), tx, by + nameSize * 1.15 + tagSize * 0.95, tagSize, 600, GREEN);
    y += headH;
    line(x0, y, x1, y, lw * 1.5);

    /* ---------- FROM ---------- */
    let cy = y + 1.5 * s;
    const lines = (arr, x, size, weight, color, lhMul = 1.3) => {
      const lh = size * lhMul;
      arr.forEach((ln) => { text(ln, x, baseline(cy, lh, size), size, weight, color); cy += lh; });
    };
    const hs = 2.4 * s * f;
    lines(['প্রেরক / FROM'], left, hs, 800, GREEN, 1.5);
    const f1 = 3.1 * s * f, f2 = 2.8 * s * f;
    lines([ellipsize(d.sender.name, 700, f1, innerW)], left, f1, 700, INK);
    if (d.sender.mobile) lines([`মোবাইল / Mobile: ${d.sender.mobile}`], left, f2, 600, INK);
    if (d.sender.address) lines(wrap(d.sender.address, 400, f2, innerW, 2), left, f2, 400, INK);
    if (d.sender.extra) lines(wrap(d.sender.extra, 400, f2 * 0.95, innerW, 2), left, f2 * 0.95, 400, '#333');
    cy += 1.2 * s;
    line(x0, cy, x1, cy, lw * 1.5);

    /* ---------- TO (the most important block: largest type) ---------- */
    cy += 1.5 * s;
    lines(['প্রাপক / TO'], left, hs, 800, GREEN, 1.5);
    const nSize = fitSize(d.to.name, 800, 4.6 * s * f, innerW, 2.6 * s);
    lines([ellipsize(d.to.name, 800, nSize, innerW)], left, nSize, 800, INK, 1.25);
    // mobile: small caption + big number on one baseline
    {
      const capSize = 2.5 * s * f, numSize = 3.9 * s * f;
      const cap = 'মোবাইল / Mobile:';
      const lh = numSize * 1.3, bl = baseline(cy, lh, numSize);
      text(cap, left, bl, capSize, 600, '#333');
      text(d.to.mobile, left + unitW(cap, 600) * capSize + 1.5 * s, bl, numSize, 800, INK);
      cy += lh;
    }
    cy += 0.4 * s;
    const labelW = 25 * s, valueX = left + labelW + 1.2 * s, valueW = right - valueX;
    const rows = [
      ['Village / গ্রাম', d.to.village], ['P.O. / ডাকঘর', d.to.po], ['Post Code / কোড', d.to.code],
      ['Thana / থানা', d.to.thana], ['District / জেলা', d.to.district]
    ];
    const vs = 3.2 * s * f;
    rows.forEach(([label, value]) => {
      const ls = fitSize(label, 600, 2.4 * s * f, labelW, 1.5 * s);
      const vl = wrap(value, 700, vs, valueW, 2);
      const lh = vs * 1.28;
      text(label, left, baseline(cy, lh, ls), ls, 600, '#333');
      vl.forEach((ln, i) => text(ln, valueX, baseline(cy + i * lh, lh, vs), vs, 700, INK));
      cy += vl.length * lh + 0.5 * s;
    });
    cy += 0.4 * s;
    line(x0, cy, x1, cy, lw * 1.5);

    /* ---------- footer geometry (fixed to the bottom) ---------- */
    const footerH = 34 * s, footerTop = y1 - footerH;

    /* ---------- PRODUCT DETAILS ---------- */
    cy += 1.3 * s;
    lines(['PRODUCT DETAILS / পণ্যের বিবরণ'], left, hs, 800, GREEN, 1.5);
    cy += 0.4 * s;
    const qtyW = 14 * s, tableTop = cy, nameW = innerW - qtyW - 2.4 * s;
    const hh = 5 * s, hdrSize = 2.5 * s * f;
    text('Product Name / পণ্যের নাম', left + 1.2 * s, baseline(cy, hh, hdrSize), hdrSize, 700, INK);
    text('Qty', right - qtyW / 2, baseline(cy, hh, hdrSize), hdrSize, 700, INK, 'middle');
    cy += hh;
    line(left, cy, right, cy, lw);
    const ps = 3 * s * f, plh = ps * 1.25;
    let hidden = 0;
    d.items.forEach((it, idx) => {
      if (hidden) { hidden++; return; }
      const nl = wrap(it.name, 600, ps, nameW, 2);
      const rh = nl.length * plh + 1.6 * s * f;
      if (cy + rh > footerTop - 1.2 * s) { hidden = 1; return; }
      nl.forEach((ln, i) => text(ln, left + 1.2 * s, baseline(cy + 0.8 * s * f + i * plh, plh, ps), ps, 600, INK));
      const qs = 3.4 * s * f;
      text(String(it.qty), right - qtyW / 2, baseline(cy, rh, qs), qs, 800, INK, 'middle');
      cy += rh;
      if (idx < d.items.length - 1) line(left, cy, right, cy, lw * 0.5, '#9bb3a5');
    });
    if (!d.items.length) cy += 1.2 * s;
    items.push({ t: 'line', x1: right - qtyW, y1: tableTop, x2: right - qtyW, y2: cy, sw: lw, c: GREEN });
    rect(left, tableTop, innerW, cy - tableTop, { stroke: GREEN, sw: lw });
    const fits = hidden === 0 && cy <= footerTop - 0.5 * s;

    /* ---------- footer: QR (left) + Order ID (right) ---------- */
    line(x0, footerTop, x1, footerTop, lw * 1.5);
    const colW = 30 * s, qrBox = 24 * s;
    const qrX = left + (colW - qrBox) / 2, qrY = footerTop + 2 * s;
    const capText = 'SCAN TO VISIT OUR PAGE';
    const capSize = fitSize(capText, 700, 2.2 * s, colW + 3 * s, 1.3 * s);
    if (d.qr) {
      // The uploaded image is placed as-is: same pixels, same proportions (never cropped or stretched).
      const r = fitRect(d.qr, qrX, qrY, qrBox, qrBox);
      items.push({ t: 'img', role: 'qr', asset: d.qr, ...r });
    } else if (preview) {
      rect(qrX, qrY, qrBox, qrBox, { stroke: '#9ca3af', sw: 0.3 * s, dash: [s, s] });
      text('QR IMAGE', qrX + qrBox / 2, qrY + qrBox / 2 + 0.8 * s, 2.4 * s, 600, '#9ca3af', 'middle');
    }
    if (d.qr || preview) text(capText, left + colW / 2, qrY + qrBox + 3.4 * s, capSize, 700, INK, 'middle');

    const px = left + colW + 3 * s, pw = right - px;
    line(px - 1.5 * s, footerTop + 2.5 * s, px - 1.5 * s, y1 - 2.5 * s, lw, '#9bb3a5');
    text('Order ID:', px, footerTop + 8 * s, 3.2 * s, 700, GREEN);
    if (d.orderId) {
      const idSize = fitSize(d.orderId, 800, 8.4 * s, pw, 3.4 * s);
      text(d.orderId, px, footerTop + 8 * s + idSize * 1.05, idSize, 800, INK);
      if (d.dateStr) text(`Date / তারিখ: ${d.dateStr}`, px, footerTop + 28 * s, 2.6 * s, 600, '#333');
    } else {
      rect(px, footerTop + 10.5 * s, pw, 10 * s, { stroke: '#b45309', sw: 0.4 * s, dash: [1.2 * s, 0.8 * s] });
      text('NOT SAVED', px + pw / 2, footerTop + 17.2 * s, fitSize('NOT SAVED', 800, 5 * s, pw - 2 * s, 2 * s), 800, '#b45309', 'middle');
      text('ID is created when you save', px, footerTop + 25 * s, 2.4 * s, 600, '#555');
    }

    return { W, H, items, fits, hidden, f };
  }

  L.warning = function (layout) {
    return layout.fits ? '' : `Not everything fits on this label size${layout.hidden ? ` (${layout.hidden} product row(s) cut off)` : ''}. Use fewer or shorter products, or make the label taller in Shop Settings.`;
  };

  /* ---------------------------------------------------------------
     Renderer 1: SVG (preview + print)
     --------------------------------------------------------------- */
  const NS = 'http://www.w3.org/2000/svg';
  const r3 = (v) => Math.round(v * 1000) / 1000;
  function svgEl(name, attrs) {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  L.toSVG = function (layout, { physical = false } = {}) {
    const { W, H } = layout;
    const svg = svgEl('svg', { xmlns: NS, viewBox: `0 0 ${W} ${H}`, 'font-family': FONT, 'text-rendering': 'geometricPrecision', role: 'img', 'aria-label': 'Parcel label' });
    if (physical) { svg.setAttribute('width', W + 'mm'); svg.setAttribute('height', H + 'mm'); }
    svg.append(svgEl('rect', { x: 0, y: 0, width: W, height: H, fill: '#ffffff' }));
    layout.items.forEach((it) => {
      if (it.t === 'rect') {
        svg.append(svgEl('rect', {
          x: r3(it.x), y: r3(it.y), width: r3(it.w), height: r3(it.h), fill: it.fill || 'none',
          ...(it.stroke ? { stroke: it.stroke, 'stroke-width': r3(it.sw) } : {}),
          ...(it.dash ? { 'stroke-dasharray': it.dash.map(r3).join(' ') } : {})
        }));
      } else if (it.t === 'line') {
        svg.append(svgEl('line', { x1: r3(it.x1), y1: r3(it.y1), x2: r3(it.x2), y2: r3(it.y2), stroke: it.c, 'stroke-width': r3(it.sw) }));
      } else if (it.t === 'text') {
        const t = svgEl('text', { x: r3(it.x), y: r3(it.y), 'font-size': r3(it.size), 'font-weight': it.weight, fill: it.color, 'text-anchor': it.anchor });
        t.textContent = it.text;
        svg.append(t);
      } else if (it.t === 'img') {
        const im = svgEl('image', { x: r3(it.x), y: r3(it.y), width: r3(it.w), height: r3(it.h), href: it.asset.url, preserveAspectRatio: 'none' });
        // small bitmaps (typical QR) are enlarged without blurring their square modules
        if (it.role === 'qr' && !it.asset.isSvg && it.asset.w < 400) im.setAttribute('style', 'image-rendering:pixelated');
        svg.append(im);
      }
    });
    return svg;
  };

  /* ---------------------------------------------------------------
     Renderer 2: canvas (used for the PDF). Text is drawn by the browser,
     so Bangla conjuncts/vowel signs are shaped correctly.
     --------------------------------------------------------------- */
  L.toCanvas = function (layout, dpi, { skipRoles = [] } = {}) {
    const k = dpi / 25.4;
    const c = document.createElement('canvas');
    c.width = Math.round(layout.W * k);
    c.height = Math.round(layout.H * k);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.textBaseline = 'alphabetic';
    ctx.imageSmoothingQuality = 'high';
    if ('fontKerning' in ctx) ctx.fontKerning = 'normal';
    if ('textRendering' in ctx) ctx.textRendering = 'geometricPrecision';
    layout.items.forEach((it) => {
      if (it.t === 'rect') {
        if (it.fill) { ctx.fillStyle = it.fill; ctx.fillRect(it.x * k, it.y * k, it.w * k, it.h * k); }
        if (it.stroke) {
          ctx.lineWidth = it.sw * k; ctx.strokeStyle = it.stroke; ctx.setLineDash(it.dash ? it.dash.map((v) => v * k) : []);
          ctx.strokeRect(it.x * k, it.y * k, it.w * k, it.h * k);
        }
      } else if (it.t === 'line') {
        ctx.lineWidth = it.sw * k; ctx.strokeStyle = it.c; ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(it.x1 * k, it.y1 * k); ctx.lineTo(it.x2 * k, it.y2 * k); ctx.stroke();
      } else if (it.t === 'text') {
        ctx.font = `${it.weight} ${it.size * k}px ${FONT}`;
        ctx.textAlign = it.anchor === 'middle' ? 'center' : it.anchor === 'end' ? 'right' : 'left';
        ctx.fillStyle = it.color;
        ctx.fillText(it.text, it.x * k, it.y * k);
      } else if (it.t === 'img' && !skipRoles.includes(it.role)) {
        ctx.drawImage(it.asset.img, it.x * k, it.y * k, it.w * k, it.h * k);
      }
    });
    return c;
  };

  /* ===============================================================
     Image assets (logo / QR) loaded from Supabase Storage
     =============================================================== */
  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Image could not be decoded'));
      img.src = url;
    });
  }

  // Display copy of an SVG: make sure it has an intrinsic size so canvas drawing keeps its proportions.
  function normalizeSvg(textIn) {
    try {
      const doc = new DOMParser().parseFromString(textIn, 'image/svg+xml');
      const svg = doc.documentElement;
      if (!svg || svg.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) return textIn;
      const ok = (a) => svg.getAttribute(a) && !/%\s*$/.test(svg.getAttribute(a));
      if (!ok('width') || !ok('height')) {
        const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
        if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) { svg.setAttribute('width', vb[2]); svg.setAttribute('height', vb[3]); }
        else { svg.setAttribute('width', 512); svg.setAttribute('height', 512); }
      }
      return new XMLSerializer().serializeToString(svg);
    } catch (e) { return textIn; }
  }

  PM.assets = {
    cache: new Map(),
    loadImage,

    publicUrl(path) {
      return PM.db.storage.from(PM.config.STORAGE_BUCKET).getPublicUrl(path).data.publicUrl;
    },

    /** -> { path, url (blob:), isSvg, w, h, img } or null */
    load(path) {
      if (!path) return Promise.resolve(null);
      if (!this.cache.has(path)) {
        const p = this._fetch(path).catch((e) => { this.cache.delete(path); throw e; });
        this.cache.set(path, p);
      }
      return this.cache.get(path);
    },

    async _fetch(path) {
      const res = await fetch(this.publicUrl(path), { cache: 'force-cache' });
      if (!res.ok) throw new Error('Could not load image (' + res.status + ')');
      let blob = await res.blob();
      const ext = path.split('.').pop().toLowerCase();
      const isSvg = ext === 'svg' || blob.type === 'image/svg+xml';
      if (isSvg) blob = new Blob([normalizeSvg(await blob.text())], { type: 'image/svg+xml' });
      else if (!blob.type.startsWith('image/')) blob = new Blob([blob], { type: ext === 'png' ? 'image/png' : 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      const img = await loadImage(url);
      return { path, url, isSvg, w: img.naturalWidth || 1000, h: img.naturalHeight || 1000, img };
    },

    /** Free cached images that are no longer used. */
    keepOnly(paths) {
      const keep = new Set(paths.filter(Boolean));
      for (const [k, p] of this.cache) {
        if (!keep.has(k)) { this.cache.delete(k); p.then((a) => URL.revokeObjectURL(a.url)).catch(() => {}); }
      }
    },

    /**
     * Lossless PNG bytes of an asset for the PDF. Bitmaps are never resampled smoothly:
     * small ones are enlarged by a whole-number factor with nearest-neighbour, so every
     * QR module stays perfectly sharp and the pixels are exactly the uploaded ones.
     */
    async toPngBytes(asset, { minSide = 1000, maxSide = 4000 } = {}) {
      const longest = Math.max(asset.w, asset.h);
      let scale = 1;
      if (asset.isSvg) scale = Math.min(maxSide, 2000) / longest;
      else if (longest < minSide) scale = Math.ceil(minSide / longest);
      else if (longest > maxSide) scale = maxSide / longest;
      const cw = Math.max(1, Math.round(asset.w * scale)), ch = Math.max(1, Math.round(asset.h * scale));
      const c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cw, ch);
      ctx.imageSmoothingEnabled = asset.isSvg || scale < 1;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(asset.img, 0, 0, cw, ch);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      if (!blob) throw new Error('Could not prepare the QR image for the PDF');
      return new Uint8Array(await blob.arrayBuffer());
    }
  };
})();
