/* =====================================================================
   printer.js — PRINT LABEL (browser print dialog) and DOWNLOAD PDF.

   PRINT LABEL   : puts only the label (vector SVG, exact mm size) into #print-root,
                   sets @page to the label size, and calls window.print().
                   CSS @media print hides everything else.
   DOWNLOAD PDF  : builds a real PDF file in the browser with pdf-lib
                   (page = label size in mm, file name = Order ID).

   About Bangla in the PDF: PDF libraries cannot shape Bangla conjuncts/vowel signs
   by themselves, so the label text is drawn by the browser (which shapes Bangla
   correctly) at up to 600 dpi and placed on the page. The QR image is added to the
   PDF as its own image (the uploaded pixels, enlarged only by whole-number
   factors), so it stays sharp and scannable. The trade-off: text in the PDF is
   an image, so it cannot be selected or searched.
   ===================================================================== */
(function () {
  'use strict';
  const PM = window.PM;
  const P = (PM.printer = {});

  /** Load logo + QR. strict=true: refuse to continue if a configured image fails (never print a label without its QR). */
  P.loadAssets = async function (settings, strict) {
    const grab = async (path, what) => {
      if (!path) return null;
      try { return await PM.assets.load(path); }
      catch (e) {
        if (strict) throw new Error(`The ${what} image could not be loaded (${PM.errMsg(e)}). Check your connection and try again.`);
        return null;
      }
    };
    const [logo, qr] = await Promise.all([grab(settings.logo_path, 'logo'), grab(settings.qr_path, 'Facebook QR')]);
    return { logo, qr };
  };

  /** Layout for a SAVED order, ready for print / PDF. */
  P.buildFinal = async function (order, settings) {
    if (!order || !order.order_id) throw new Error('Save the order first — the Order ID is created when it is saved.');
    await PM.label.ensureFonts();
    const assets = await P.loadAssets(settings, true);
    const { W, H } = PM.label.dims(settings);
    return PM.label.layout(PM.label.makeData(order, settings, assets, false), { W, H, preview: false });
  };

  /** Draw an on-screen preview (sync; uses already-loaded assets). Returns the layout. */
  P.renderPreview = function (container, order, settings, assets, warnEl) {
    const { W, H } = PM.label.dims(settings);
    const layout = PM.label.layout(PM.label.makeData(order, settings, assets, true), { W, H, preview: true });
    container.replaceChildren(PM.label.toSVG(layout));
    if (warnEl) PM.showError(warnEl, PM.label.warning(layout));
    return layout;
  };

  /* ---------------------------------------------------------------
     PRINT LABEL
     --------------------------------------------------------------- */
  P.print = async function (order, settings) {
    const layout = await P.buildFinal(order, settings);
    if (!layout.fits) {
      const ok = await PM.confirm({ title: 'Label does not fully fit', message: PM.label.warning(layout) + ' Print anyway?', okText: 'Print anyway' });
      if (!ok) return;
    }
    const { W, H } = layout;
    const root = PM.$('#print-root');
    root.replaceChildren(PM.label.toSVG(layout, { physical: true }));
    root.style.width = W + 'mm';
    root.style.height = H + 'mm';
    PM.$('#page-style').textContent = `@page { size: ${W}mm ${H}mm; margin: 0; }`;

    // make sure the images are decoded before the print dialog takes its snapshot
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await Promise.all(layout.items.filter((i) => i.t === 'img').map((i) => i.asset.img.decode().catch(() => {})));
    await new Promise((r) => setTimeout(r, 150));

    const cleanup = () => {
      root.replaceChildren();
      PM.$('#page-style').textContent = '';
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    window.print();
    setTimeout(cleanup, 120000);        // some mobile browsers never fire "afterprint"
  };

  /* ---------------------------------------------------------------
     DOWNLOAD PDF
     --------------------------------------------------------------- */
  const canvasToBytes = async (canvas) => {
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    if (!blob) throw new Error('Not enough memory to build the PDF on this device. Try a smaller label size.');
    return new Uint8Array(await blob.arrayBuffer());
  };

  P.download = function (blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = PM.el('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  };

  P.makePdfBytes = async function (order, settings) {
    if (!window.PDFLib) throw new Error('The PDF library could not be loaded. Check your internet connection and reload the page.');
    const layout = await P.buildFinal(order, settings);
    const { W, H } = layout;
    const dpi = Math.min(600, Math.sqrt(36e6 / ((W / 25.4) * (H / 25.4))));      // cap at ~36 megapixels
    const canvas = PM.label.toCanvas(layout, dpi, { skipRoles: ['qr'] });
    const pageBytes = await canvasToBytes(canvas);

    const pdf = await window.PDFLib.PDFDocument.create();
    const pt = (mm) => (mm / 25.4) * 72;
    const page = pdf.addPage([pt(W), pt(H)]);
    page.drawImage(await pdf.embedPng(pageBytes), { x: 0, y: 0, width: pt(W), height: pt(H) });

    const qr = layout.items.find((i) => i.t === 'img' && i.role === 'qr');
    if (qr) {
      const img = await pdf.embedPng(await PM.assets.toPngBytes(qr.asset));
      page.drawImage(img, { x: pt(qr.x), y: pt(H) - pt(qr.y + qr.h), width: pt(qr.w), height: pt(qr.h) });
    }
    pdf.setTitle(order.order_id);
    pdf.setSubject('Parcel label');
    pdf.setCreator('Parcel Manager');
    pdf.setProducer('Parcel Manager');
    return { bytes: await pdf.save(), fits: layout.fits, warning: PM.label.warning(layout) };
  };

  P.downloadPdf = async function (order, settings) {
    const { bytes, fits, warning } = await P.makePdfBytes(order, settings);
    P.download(new Blob([bytes], { type: 'application/pdf' }), `${order.order_id}.pdf`);
    if (!fits) PM.toast(warning, 'warn', 8000);
  };

  /* ---------------------------------------------------------------
     Sample preview (Settings page -> "Preview Label")
     --------------------------------------------------------------- */
  P.sampleOrder = function () {
    return {
      order_id: 'SP-BW583921', created_at: new Date().toISOString(),
      customer_name: 'মোঃ রহিম উদ্দিন', mobile: '01712345678', village: 'কাজীপাড়া', post_office: 'মিরপুর',
      post_code: '1216', thana: 'মিরপুর', district: 'ঢাকা',
      items: [{ product_name: 'Kids Toy Car', quantity: 2 }, { product_name: 'LED Table Lamp / এলইডি ল্যাম্প', quantity: 1 }, { product_name: 'Home Decor Wall Clock', quantity: 3 }]
    };
  };
})();
