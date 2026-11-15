/* West Residences – in-app PDF reader
   Search inside the manual, bookmarks, highlights, open the whole PDF, download.
   Bookmarks and highlights are saved on the reader's own device (localStorage). */
(function () {
  "use strict";
  const LS = "wr-reader:v1:";
  const COLORS = { yellow: "#ffe14d", pink: "#ff9bbd", green: "#85e594", blue: "#86ccff" };
  const ZOOMS = [0.75, 1, 1.25, 1.5, 2, 3];
  const byId = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const uid = () => Math.random().toString(36).slice(2, 10);

  let lib = null, pdf = null, S = null, root = null, isOpen = false;
  const textIndex = new Map(); // path -> {pages:[...], promise}

  const loadSaved = (path) => { try { return JSON.parse(localStorage.getItem(LS + path)) || {}; } catch { return {}; } };
  const persist = () => { try { localStorage.setItem(LS + S.path, JSON.stringify({ bm: S.bm, hl: S.hl, zoom: S.zoom })); } catch {} };

  async function getLib() {
    if (lib) return lib;
    lib = await import(new URL("vendor/pdf.min.mjs", document.baseURI).href);
    lib.GlobalWorkerOptions.workerSrc = new URL("vendor/pdf.worker.min.mjs", document.baseURI).href;
    return lib;
  }

  /* ---------- interface ---------- */
  function build() {
    if (root) return;
    root = document.createElement("div");
    root.id = "rd"; root.className = "rd"; root.hidden = true;
    root.setAttribute("role", "dialog"); root.setAttribute("aria-modal", "true"); root.setAttribute("aria-label", "Manual reader");
    root.innerHTML = `
      <div class="rd-top">
        <button type="button" class="rd-back" id="rdClose" aria-label="Close the reader"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>Back</button>
        <div class="rd-ttl"><div class="rd-name" id="rdName"></div><button type="button" class="rd-pg" id="rdPg">Page 1</button></div>
        <button type="button" class="rd-ico" id="rdBm" aria-label="Bookmark this page" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10v16l-5-3.6L7 20z"/></svg></button>
      </div>
      <div class="rd-bars" id="rdBars">
        <div class="rd-bar" role="toolbar" aria-label="Reader tools">
          <button type="button" id="rdTocBtn" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>Contents</button>
          <button type="button" id="rdSearchBtn"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6"/><path d="m20 20-4.8-4.8"/></svg>Search</button>
          <button type="button" id="rdMarksBtn"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10v16l-5-3.6L7 20z"/></svg>Bookmarks</button>
          <span class="grow"></span>
          <button type="button" id="rdZoomOut" aria-label="Zoom out" class="sq">−</button>
          <button type="button" id="rdZoomIn" aria-label="Zoom in" class="sq">+</button>
        </div>
        <div class="rd-bar rd-files">
          <a id="rdOpen" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5H5V6h5"/></svg>Open PDF</a>
          <a id="rdDl" download><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14"/></svg>Download</a>
        </div>
      </div>
      <div class="rd-body">
        <div class="rd-panel" id="rdPanel" hidden></div>
        <div class="rd-scroll" id="rdScroll"><div class="rd-pages" id="rdPages"></div></div>
        <div class="rd-msg" id="rdMsg" role="status"></div>
        <div class="rd-sel" id="rdSel" hidden></div>
        <button type="button" class="rd-ret" id="rdRet" hidden></button>
      </div>`;
    document.body.append(root);

    byId("rdClose").onclick = close;
    byId("rdSearchBtn").onclick = () => togglePanel("search");
    byId("rdMarksBtn").onclick = () => togglePanel("marks");
    byId("rdTocBtn").onclick = () => togglePanel("toc");
    byId("rdRet").onclick = () => { const r = S && S.ret; byId("rdRet").hidden = true; if (r) byId("rdScroll").scrollTo({ top: r.top, behavior: "smooth" }); };
    byId("rdBm").onclick = toggleBookmark;
    byId("rdZoomIn").onclick = () => zoomBy(1);
    byId("rdZoomOut").onclick = () => zoomBy(-1);
    byId("rdPg").onclick = () => {
      const n = parseInt(prompt("Go to page (1 to " + (pdf ? pdf.numPages : 1) + ")", String(S.cur + 1)), 10);
      if (n >= 1 && pdf && n <= pdf.numPages) goTo(n - 1);
    };
    byId("rdOpen").addEventListener("click", () => { byId("rdOpen").href = S.url + "#page=" + (S.cur + 1); });
    byId("rdScroll").addEventListener("scroll", () => { if (!S.raf) S.raf = requestAnimationFrame(onScroll); }, { passive: true });
    byId("rdScroll").addEventListener("click", onPageClick);
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("popstate", () => { if (isOpen) hide(); });
    window.addEventListener("resize", () => { if (isOpen) { clearTimeout(S.rz); S.rz = setTimeout(() => layout(true), 200); } });
    document.addEventListener("keydown", (e) => {
      if (!isOpen) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); togglePanel("search", true); }
      else if (e.key === "Escape") { if (!byId("rdPanel").hidden && !/INPUT/.test(document.activeElement.tagName)) togglePanel(null); else if (!byId("rdPanel").hidden) togglePanel(null); else close(); }
    });
  }

  /* ---------- open / close ---------- */
  async function open(path, title, page) {
    build();
    if (isOpen) hide();
    const saved = loadSaved(path);
    S = {
      path, title: title || path.split("/").pop(), url: new URL(path, document.baseURI).href,
      bm: saved.bm || [], hl: saved.hl || [], zoom: saved.zoom && ZOOMS.includes(saved.zoom) ? saved.zoom : 1,
      els: [], sizes: [], cur: 0, tok: 0, words: [], results: [], ri: -1, panel: null, toc: null, ret: null, q: "", obs: null, raf: 0,
    };
    isOpen = true; root.hidden = false; document.body.style.overflow = "hidden";
    byId("rdName").textContent = S.title;
    byId("rdPages").replaceChildren(); byId("rdPanel").hidden = true; hideSel();
    byId("rdBars").classList.remove("away"); byId("rdTocBtn").hidden = true; byId("rdRet").hidden = true; byId("rdTocBtn").classList.remove("on");
    byId("rdOpen").href = S.url; byId("rdDl").href = S.url; byId("rdDl").setAttribute("download", path.split("/").pop());
    byId("rdPg").textContent = "Opening…";
    msg("Opening the manual…");
    try { history.pushState({ wrReader: 1 }, ""); } catch {}
    try {
      const L = await getLib();
      const base = (p) => new URL(p, document.baseURI).href;
      const task = L.getDocument({ url: S.url, cMapUrl: base("vendor/cmaps/"), iccUrl: base("vendor/iccs/"), cMapPacked: true, standardFontDataUrl: base("vendor/standard_fonts/"), wasmUrl: base("vendor/wasm/") });
      const doc = await task.promise;
      if (!isOpen || !S || S.path !== path) { doc.destroy(); return; }
      pdf = doc;
      S.sizes = await Promise.all(Array.from({ length: pdf.numPages }, async (_, i) => { const v = (await pdf.getPage(i + 1)).getViewport({ scale: 1 }); return { w: v.width, h: v.height }; }));
      msg("");
      const wrap = byId("rdPages");
      for (let i = 0; i < pdf.numPages; i++) {
        const d = document.createElement("div"); d.className = "rd-pgel"; d.dataset.i = i; wrap.append(d); S.els.push(d);
      }
      S.obs = new IntersectionObserver((ents) => {
        for (const e of ents) { const i = +e.target.dataset.i; if (e.isIntersecting) renderPage(i); else release(i); }
      }, { root: byId("rdScroll"), rootMargin: "1400px 0px" });
      layout(false);
      S.els.forEach((el) => S.obs.observe(el));
      markBookmarks(); onScroll(); updateBm();
      loadToc(path);
      if (page && page > 1) goTo(page - 1);
    } catch (e) {
      console.warn(e);
      msg("Couldn't open this PDF here. Use Open PDF or Download above.");
      byId("rdPg").textContent = "";
    }
  }
  function hide() {
    if (!isOpen) return;
    isOpen = false; root.hidden = true; document.body.style.overflow = "";
    if (S && S.obs) S.obs.disconnect();
    if (pdf) { try { pdf.destroy(); } catch {} pdf = null; }
    byId("rdPages").replaceChildren(); hideSel();
  }
  function close() {
    if (!isOpen) return;
    if (history.state && history.state.wrReader) history.back(); else hide();
  }
  const msg = (t) => { byId("rdMsg").textContent = t; byId("rdMsg").hidden = !t; };

  /* ---------- layout + rendering ---------- */
  function layout(keepPlace) {
    if (!pdf) return;
    const sc = byId("rdScroll");
    const place = keepPlace ? S.cur : 0;
    const width = Math.max(240, sc.clientWidth - 16);
    S.tok++;
    S.els.forEach((el, i) => {
      const z = S.sizes[i], k = (width * S.zoom) / z.w;
      el._scale = k; el._done = false; el._busy = false;
      el.style.width = z.w * k + "px"; el.style.height = z.h * k + "px";
      el.replaceChildren();
    });
    if (S.obs) { S.els.forEach((el) => { S.obs.unobserve(el); S.obs.observe(el); }); }
    if (keepPlace) goTo(place, false);
  }
  function release(i) { const el = S.els[i]; if (!el || !el._done) return; el.replaceChildren(); el._done = false; }
  async function renderPage(i) {
    const el = S.els[i];
    if (!el || el._done || el._busy || !pdf) return;
    const tok = S.tok; el._busy = true;
    try {
      const page = await pdf.getPage(i + 1);
      if (tok !== S.tok || !isOpen) return;
      const k = el._scale, vp = page.getViewport({ scale: k });
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cv = document.createElement("canvas");
      cv.width = Math.ceil(vp.width * dpr); cv.height = Math.ceil(vp.height * dpr);
      cv.style.width = vp.width + "px"; cv.style.height = vp.height + "px";
      const hl = document.createElement("div"); hl.className = "rd-hl";
      const tx = document.createElement("div"); tx.className = "textLayer";
      tx.style.setProperty("--scale-factor", k); tx.style.setProperty("--total-scale-factor", k);
      el.replaceChildren(cv, hl, tx);
      const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined;
      try { await page.render({ canvas: cv, viewport: vp, transform }).promise; }
      catch (err) { if (err && err.name === "RenderingCancelledException") throw err; await page.render({ canvasContext: cv.getContext("2d"), viewport: vp, transform }).promise; }
      if (tok !== S.tok || !el.isConnected) return;
      const tl = new lib.TextLayer({ textContentSource: page.streamTextContent(), container: tx, viewport: vp });
      await tl.render();
      if (tok !== S.tok) return;
      el._done = true;
      markSearch(tx); drawHighlights(i);
      drawLinks(el, page, vp, tok);
      linkifyText(el, tx, tok);
    } catch (e) { if (!e || e.name !== "RenderingCancelledException") console.warn("page " + (i + 1), e); }
    finally { el._busy = false; }
  }

  function onScroll() {
    S.raf = 0;
    const sc = byId("rdScroll"), top = sc.scrollTop + sc.clientHeight * 0.3;
    const dy = sc.scrollTop - (S.lastTop || 0);
    if (Math.abs(dy) > 14) {
      const bars = byId("rdBars");
      if (dy > 0 && sc.scrollTop > 160 && byId("rdPanel").hidden) bars.classList.add("away"); else if (dy < 0) bars.classList.remove("away");
      S.lastTop = sc.scrollTop;
    }
    let cur = 0;
    for (let i = 0; i < S.els.length; i++) { const el = S.els[i]; if (el.offsetTop + el.offsetHeight > top) { cur = i; break; } cur = i; }
    if (cur !== S.cur || !byId("rdPg").dataset.set) {
      S.cur = cur; byId("rdPg").dataset.set = "1";
      byId("rdPg").textContent = "Page " + (cur + 1) + " of " + (pdf ? pdf.numPages : "?");
      updateBm();
    }
  }
  function goTo(i, smooth, y) {
    const el = S.els[i]; if (!el) return;
    const sc = byId("rdScroll");
    let top = el.offsetTop - 8;
    if (typeof y === "number" && S.sizes[i] && el._scale && y >= 0 && y <= S.sizes[i].h) top = el.offsetTop + (S.sizes[i].h - y) * el._scale - 56;
    sc.scrollTo({ top: Math.max(el.offsetTop - 8, top), behavior: smooth === false ? "auto" : "smooth" });
  }
  /* jump from a contents entry or an in-page link, with a way back */
  function jump(r) {
    if (!r || r.page == null || !S.els[r.page]) return;
    const from = byId("rdScroll").scrollTop, fromPage = S.cur;
    if (Math.abs(r.page - fromPage) >= 1) {
      S.ret = { top: from, page: fromPage };
      const b = byId("rdRet"); b.textContent = "↩ Back to page " + (fromPage + 1); b.hidden = false;
      clearTimeout(S.retT); S.retT = setTimeout(() => { b.hidden = true; }, 15000);
    }
    goTo(r.page, true, r.y);
  }
  function zoomBy(d) {
    const i = Math.max(0, Math.min(ZOOMS.length - 1, ZOOMS.indexOf(S.zoom) + d));
    if (ZOOMS[i] === S.zoom) return;
    S.zoom = ZOOMS[i]; persist(); layout(true);
  }

  /* ---------- bookmarks ---------- */
  function updateBm() {
    const on = S.bm.some((b) => b.page === S.cur);
    const b = byId("rdBm"); b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
    b.setAttribute("aria-label", on ? "Remove bookmark from this page" : "Bookmark this page");
  }
  function markBookmarks() { S.els.forEach((el, i) => el.classList.toggle("bm", S.bm.some((b) => b.page === i))); }
  function toggleBookmark() {
    const ex = S.bm.findIndex((b) => b.page === S.cur);
    if (ex >= 0) S.bm.splice(ex, 1); else S.bm.push({ id: uid(), page: S.cur, label: "Page " + (S.cur + 1), t: Date.now() });
    S.bm.sort((a, b) => a.page - b.page);
    persist(); markBookmarks(); updateBm(); if (S.panel === "marks") renderPanel();
  }

  /* ---------- highlights ---------- */
  function drawHighlights(i) {
    const el = S.els[i]; if (!el) return;
    const layer = el.querySelector(".rd-hl"); if (!layer) return;
    layer.replaceChildren();
    for (const h of S.hl) {
      if (h.page !== i) continue;
      for (const r of h.rects) {
        const d = document.createElement("div"); d.dataset.id = h.id; d.style.cssText =
          `left:${r[0] * 100}%;top:${r[1] * 100}%;width:${r[2] * 100}%;height:${r[3] * 100}%;background:${COLORS[h.color] || COLORS.yellow}`;
        layer.append(d);
      }
    }
  }
  let selTimer = 0;
  function onSelectionChange() {
    if (!isOpen) return;
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      const sel = getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) { if (S.selMode === "new") hideSel(); return; }
      const node = sel.getRangeAt(0).commonAncestorContainer;
      const elx = node.nodeType === 1 ? node : node.parentElement;
      if (!elx || !byId("rdScroll").contains(elx) || !elx.closest(".textLayer, .rd-pagesx, .rd-pgel")) { if (S.selMode === "new") hideSel(); return; }
      showSel("new");
    }, 250);
  }
  function showSel(mode, id) {
    S.selMode = mode; S.selId = id || null;
    const bar = byId("rdSel"); bar.hidden = false;
    if (mode === "new") {
      bar.innerHTML = `<span class="lbl">Highlight</span>` +
        Object.entries(COLORS).map(([n, c]) => `<button type="button" class="dot" data-c="${n}" style="background:${c}" aria-label="Highlight ${n}"></button>`).join("") +
        `<button type="button" class="x" data-x="1" aria-label="Cancel">Cancel</button>`;
    } else {
      bar.innerHTML = `<button type="button" class="rm" data-rm="1">Remove highlight</button><button type="button" class="x" data-x="1" aria-label="Close">Close</button>`;
    }
    bar.onclick = (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.c) createHighlight(b.dataset.c);
      else if (b.dataset.rm) removeHighlight(S.selId);
      else hideSel(true);
    };
  }
  function hideSel(clear) { S && (S.selMode = null); const b = byId("rdSel"); if (b) b.hidden = true; if (clear) { const s = getSelection(); s && s.removeAllRanges(); } }
  function createHighlight(color) {
    const sel = getSelection(); if (!sel || !sel.rangeCount || sel.isCollapsed) return hideSel();
    const text = sel.toString().replace(/[.·…_\-]{4,}/g, " … ").replace(/\s+/g, " ").trim();
    const rects = [...sel.getRangeAt(0).getClientRects()];
    const touched = new Set();
    S.els.forEach((el, i) => {
      if (!el._done) return;
      const pr = el.getBoundingClientRect(), out = [];
      for (const r of rects) {
        if (r.width < 1 || r.height < 1 || r.width > pr.width * 0.98) continue;
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (cx < pr.left || cx > pr.right || cy < pr.top || cy > pr.bottom) continue;
        out.push([(r.left - pr.left) / pr.width, (r.top - pr.top) / pr.height, r.width / pr.width, r.height / pr.height]);
      }
      const keep = out.filter((a, ai) => !out.some((b, bi) => bi !== ai && b[0] <= a[0] + 0.001 && b[1] <= a[1] + 0.001 && b[0] + b[2] >= a[0] + a[2] - 0.001 && b[1] + b[3] >= a[1] + a[3] - 0.001 && (b[2] * b[3] > a[2] * a[3] || (b[2] * b[3] === a[2] * a[3] && bi < ai))));
      if (!keep.length) return;
      S.hl.push({ id: uid(), page: i, color, text, rects: keep, t: Date.now() }); touched.add(i);
    });
    persist(); touched.forEach(drawHighlights); hideSel(true);
    if (S.panel === "marks") renderPanel();
  }
  function removeHighlight(id) {
    const h = S.hl.find((x) => x.id === id); S.hl = S.hl.filter((x) => x.id !== id); persist();
    if (h) drawHighlights(h.page); hideSel(true); if (S.panel === "marks") renderPanel();
  }
  function onPageClick(e) {
    if (e.target.closest(".rd-msg")) return;
    const sel = getSelection(); if (sel && !sel.isCollapsed) return;
    const pg = e.target.closest(".rd-pgel"); if (!pg) { hideSel(); return; }
    const i = +pg.dataset.i, pr = pg.getBoundingClientRect();
    const x = (e.clientX - pr.left) / pr.width, y = (e.clientY - pr.top) / pr.height;
    const hit = S.hl.find((h) => h.page === i && h.rects.some((r) => x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3]));
    if (hit) showSel("remove", hit.id); else hideSel();
  }

  /* ---------- search ---------- */
  function words(q) { return [...new Set(q.toLowerCase().split(/\s+/).filter((w) => w.length > 1))]; }
  function markSearch(tx) {
    if (!S.words.length) return;
    const re = new RegExp("(" + S.words.map(escRe).join("|") + ")", "gi");
    tx.querySelectorAll("span").forEach((sp) => {
      if (sp.children.length || sp.getAttribute("role") === "img") return;
      const t = sp.textContent; if (!re.test(t)) { re.lastIndex = 0; return; }
      re.lastIndex = 0;
      const parts = t.split(re), frag = document.createDocumentFragment();
      parts.forEach((p, k) => { if (!p) return; if (k % 2) { const m = document.createElement("mark"); m.className = "rd-m"; m.textContent = p; frag.append(m); } else frag.append(p); });
      sp.replaceChildren(frag);
    });
  }
  function refreshMarks() {
    S.els.forEach((el) => {
      if (!el._done) return;
      const tx = el.querySelector(".textLayer"); if (!tx) return;
      tx.querySelectorAll("mark.rd-m").forEach((m) => { const sp = m.parentElement; sp.textContent = sp.textContent; });
      markSearch(tx);
    });
  }
  function indexText(onProgress) {
    let ix = textIndex.get(S.path);
    if (ix) return ix.promise;
    ix = { pages: [] };
    const doc = pdf, path = S.path;
    ix.promise = (async () => {
      for (let i = 1; i <= doc.numPages; i++) {
        const p = await doc.getPage(i); const tc = await p.getTextContent();
        ix.pages.push(tc.items.map((it) => it.str + (it.hasEOL ? " " : " ")).join("").replace(/\s+/g, " ").trim());
        if (onProgress && S && S.path === path) onProgress(i, doc.numPages);
      }
      ix.chars = ix.pages.reduce((n, t) => n + t.length, 0);
      return ix;
    })();
    textIndex.set(path, ix);
    return ix.promise;
  }
  async function runSearch(q) {
    const list = byId("rdResults"), info = byId("rdInfo");
    S.q = q.trim(); S.words = words(S.q); S.results = []; S.ri = -1;
    if (S.q.length < 2) { list.replaceChildren(); info.textContent = ""; refreshMarks(); return; }
    info.textContent = "Searching…";
    const ix = await indexText((i, n) => { if (!S.results.length) info.textContent = "Reading the manual… " + i + "/" + n; });
    if (!S || byId("rdQ").value.trim() !== S.q) return;
    if (ix.chars < 10 * ix.pages.length) {
      info.textContent = "This PDF is made of scanned pictures, so it can't be searched. Use the page number to jump around, or Open PDF.";
      list.replaceChildren(); return;
    }
    const phrase = S.q.toLowerCase().replace(/\s+/g, " ");
    const ws = words(phrase);
    let total = 0;
    ix.pages.forEach((txt, i) => {
      const low = txt.toLowerCase();
      let count = 0, at = low.indexOf(phrase), first = at;
      while (at >= 0) { count++; at = low.indexOf(phrase, at + phrase.length); }
      if (!count && ws.length > 1 && ws.every((w) => low.includes(w))) { count = 1; first = low.indexOf(ws[0]); }
      if (!count) return;
      total += count;
      const s = Math.max(0, first - 50), e = Math.min(txt.length, first + phrase.length + 70);
      let snip = esc(txt.slice(s, e));
      const hre = new RegExp("(" + S.words.map((w) => escRe(esc(w))).join("|") + ")", "gi");
      snip = (s > 0 ? "…" : "") + snip.replace(hre, "<mark>$1</mark>") + (e < txt.length ? "…" : "");
      S.results.push({ page: i, count, snip });
    });
    info.textContent = S.results.length ? `${total} match${total === 1 ? "" : "es"} on ${S.results.length} page${S.results.length === 1 ? "" : "s"}` : "No matches. Try a shorter or different word.";
    list.innerHTML = S.results.slice(0, 300).map((r, k) =>
      `<button type="button" class="rd-res" data-k="${k}"><b>Page ${r.page + 1}</b><span>${r.snip}</span></button>`).join("");
    refreshMarks();
  }
  function pickResult(k) {
    S.ri = (k + S.results.length) % S.results.length;
    const r = S.results[S.ri]; if (!r) return;
    byId("rdInfo").textContent = `Result ${S.ri + 1} of ${S.results.length} · page ${r.page + 1}`;
    byId("rdPanel").classList.add("compact");
    goTo(r.page);
    let tries = 0; const page = r.page, ri = S.ri;
    const t = setInterval(() => {
      if (!isOpen || S.ri !== ri) return clearInterval(t);
      const el = S.els[page], m = el && el.querySelector("mark.rd-m");
      if (m) {
        clearInterval(t);
        const sc = byId("rdScroll"), pn = byId("rdPanel"), ph = pn.hidden ? 0 : pn.offsetHeight;
        const y = m.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - ph - 90;
        sc.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
      } else if (++tries > 25) clearInterval(t);
    }, 150);
  }

  /* ---------- contents (outline) and clickable links ---------- */
  async function destToPage(dest) {
    try {
      let d = dest; if (typeof d === "string") d = await pdf.getDestination(d);
      if (!Array.isArray(d) || d[0] == null) return null;
      const page = typeof d[0] === "object" ? await pdf.getPageIndex(d[0]) : +d[0];
      let y = null;
      if (d[1] && d[1].name === "XYZ" && typeof d[3] === "number") y = d[3];
      else if (d[1] && d[1].name === "FitH" && typeof d[2] === "number") y = d[2];
      return { page, y };
    } catch { return null; }
  }
  async function loadToc(path) {
    let items = [];
    try {
      const ol = await pdf.getOutline();
      if (ol && ol.length) {
        const flat = [];
        (function walk(a, d) { for (const n of a) { flat.push({ t: (n.title || "").replace(/\s+/g, " ").trim(), d, dest: n.dest }); if (n.items && n.items.length) walk(n.items, d + 1); } })(ol, 0);
        const res = await Promise.all(flat.map((f) => (f.dest ? destToPage(f.dest) : null)));
        flat.forEach((f, i) => { if (res[i]) { f.page = res[i].page; f.y = res[i].y; } });
        items = flat.filter((f) => f.t && f.page != null && f.page >= 0);
      }
    } catch (e) { console.warn("outline", e); }
    if (!items.length && pdf.numPages >= 8) { try { items = await printedToc(); } catch (e) { console.warn("printed contents", e); } }
    if (!S || S.path !== path) return;
    S.toc = items; byId("rdTocBtn").hidden = !items.length;
  }
  /* manuals with no built-in contents list: read the printed contents page (lines like "Title ....... 12") */
  async function printedToc() {
    const ix = await indexText();
    const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const found = [];
    for (let pg = 0; pg < Math.min(10, ix.pages.length); pg++) {
      const txt = ix.pages[pg], re = /\s*(.+?)\s*\.{4,}\s*(\d{1,3})(?=\s|$)/g; let m; const here = [];
      while ((m = re.exec(txt))) { const t = m[1].replace(/^\d*\s*(table of )?contents\s*/i, "").replace(/\s+/g, " ").trim(); let tt = t; if (tt.length > 70) { const k = tt.search(/\s\d{1,2}\.\s+\S[^.]*$/); tt = k >= 0 ? tt.slice(k + 1) : tt.slice(-50); }
        if (tt.length > 2) here.push({ t: tt, n: +m[2] }); }
      if (here.length >= 4) found.push(...here);
    }
    if (found.length < 4) return [];
    let best = -1, bestHits = 0;
    for (let off = -2; off <= 14; off++) {
      let hits = 0;
      for (const e of found) { const pgx = ix.pages[e.n - 1 + off]; const k = norm(e.t).slice(0, 24); if (pgx && k.length > 2 && norm(pgx).includes(k)) hits++; }
      if (hits > bestHits) { bestHits = hits; best = off; }
    }
    if (best === -1 || bestHits < Math.max(3, found.length * 0.5)) return [];
    return found.map((e) => ({ t: e.t, d: 0, page: e.n - 1 + best, y: null })).filter((e) => e.page >= 0 && e.page < ix.pages.length);
  }
  async function drawLinks(el, page, vp, tok) {
    try {
      const an = await page.getAnnotations({ intent: "display" });
      if (tok !== S.tok || !el.isConnected) return;
      const layer = document.createElement("div"); layer.className = "rd-links";
      for (const a of an) {
        if (a.subtype !== "Link" || !a.rect) continue;
        const url = a.url || a.unsafeUrl, ok = url && /^(https?:|mailto:|tel:)/i.test(url);
        if (!a.dest && !ok) continue;
        const T = vp.transform, ap = (x, y) => [T[0] * x + T[2] * y + T[4], T[1] * x + T[3] * y + T[5]];
        const [x1, y1] = ap(a.rect[0], a.rect[1]), [x2, y2] = ap(a.rect[2], a.rect[3]);
        const l = document.createElement("a"); l.className = "rd-lnk";
        l.style.left = Math.min(x1, x2) + "px"; l.style.top = Math.min(y1, y2) + "px"; l.style.width = Math.abs(x2 - x1) + "px"; l.style.height = Math.abs(y2 - y1) + "px";
        if (a.dest) { l.href = "#"; l._dest = a.dest; l.setAttribute("aria-label", "Jump to this section"); }
        else { l.href = url; l.target = "_blank"; l.rel = "noopener"; }
        layer.append(l);
      }
      if (layer.children.length) {
        layer.addEventListener("click", (e) => { const l = e.target.closest(".rd-lnk"); if (l && l._dest) { e.preventDefault(); e.stopPropagation(); destToPage(l._dest).then(jump); } });
        el.append(layer);
      }
    } catch (e) { console.warn("links", e); }
  }

  /* ---------- phone numbers, emails and web addresses in the text ---------- */
  const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
  const RE_URL = /(?:https?:\/\/|www\.)[^\s<>"')\]]*[^\s<>"')\].,;:!?]|(?<![@\w.-])[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|net|org|gov|edu|io|co)(?:\.au|\.nz|\.uk)?(?:\/[^\s<>"')\]]*[^\s<>"')\].,;:!?])?(?![\w@-])/gi;
  const RE_PHONE = [
    /(?<![\d.+])(?:\+?61[\s-]?\(?0?\)?[\s-]?|\(?0)[2378]\)?[\s-]?\d{4}[\s-]?\d{4}(?!\d)/g,
    /(?<![\d.+])(?:\+?61[\s-]?|0)4\d{2}[\s-]?\d{3}[\s-]?\d{3}(?!\d)/g,
    /(?<![\d.+])1[38]00[\s-]?\d{3}[\s-]?\d{3}(?!\d)/g,
    /(?<![\d.+])13(?:[\s-]\d{2}[\s-]\d{2}|\d{4})(?![\d.]|\s?\d)/g,
    /(?<![\d.\w])\+\d{1,3}[\s-]?\(?\d{1,4}\)?(?:[\s-]?\d{2,4}){2,4}(?!\d)/g,
  ];
  function findContacts(text) {
    const out = [], used = (a, b) => out.some((o) => a < o.e && b > o.s);
    let m;
    RE_EMAIL.lastIndex = 0;
    while ((m = RE_EMAIL.exec(text))) out.push({ s: m.index, e: m.index + m[0].length, href: "mailto:" + m[0], kind: "email" });
    RE_URL.lastIndex = 0;
    while ((m = RE_URL.exec(text))) {
      const a = m.index, b = a + m[0].length; if (used(a, b)) continue;
      let u = m[0]; if (/-$/.test(u)) u = u.slice(0, u.lastIndexOf("/") + 1) || u.slice(0, -1);   // a link that wrapped mid-word: open the section it is in
      out.push({ s: a, e: b, href: /^https?:/i.test(u) ? u : "https://" + u, kind: "web" });
    }
    for (const re of RE_PHONE) {
      re.lastIndex = 0;
      while ((m = re.exec(text))) {
        const a = m.index, b = a + m[0].length; if (used(a, b)) continue;
        let digits = m[0].replace(/[^\d+]/g, ""); digits = digits.replace(/^\+610/, "+61"); if (digits.replace(/\D/g, "").length < 6) continue;
        out.push({ s: a, e: b, href: "tel:" + digits, kind: "phone" });
      }
    }
    return out.sort((x, y) => x.s - y.s);
  }
  function linkifyText(el, tx, tok) {
    try {
      if (tok !== S.tok || !el.isConnected) return;
      const nodes = [], walker = document.createTreeWalker(tx, NodeFilter.SHOW_TEXT);
      let text = "", n, prevTop = null, prevEnd = "";
      while ((n = walker.nextNode())) {
        const v = n.nodeValue; if (!v) continue;
        const top = n.parentElement && n.parentElement.closest("span") ? Math.round(n.parentElement.closest("span").getBoundingClientRect().top / 3) : null;
        const sep = text && !(prevEnd && !/\s/.test(prevEnd) && !/^\s/.test(v) && top === prevTop) ? " " : "";
        text += sep; nodes.push({ n, start: text.length, len: v.length }); text += v; prevTop = top; prevEnd = v.slice(-1);
      }
      const found = findContacts(text); if (!found.length) return;
      const layer = document.createElement("div"); layer.className = "rd-links det";
      const er = el.getBoundingClientRect();
      const at = (pos, isEnd) => { for (const x of nodes) if (pos >= x.start && pos <= x.start + x.len && (!isEnd ? pos < x.start + x.len || x === nodes[nodes.length - 1] : pos > x.start)) return [x.n, pos - x.start]; return null; };
      for (const f of found) {
        const a = at(f.s, false), b = at(f.e, true); if (!a || !b) continue;
        const r = document.createRange(); r.setStart(a[0], a[1]); r.setEnd(b[0], b[1]);
        for (const q of r.getClientRects()) {
          if (q.width < 2 || q.height < 2) continue;
          const l = document.createElement("a"); l.className = "rd-lnk ext " + f.kind; l.href = f.href;
          if (f.kind === "web") { l.target = "_blank"; l.rel = "noopener"; }
          l.setAttribute("aria-label", (f.kind === "phone" ? "Call " : f.kind === "email" ? "Email " : "Open ") + text.slice(f.s, f.e));
          l.style.left = q.left - er.left - 1 + "px"; l.style.top = q.top - er.top - 1 + "px"; l.style.width = q.width + 2 + "px"; l.style.height = q.height + 2 + "px";
          layer.append(l);
        }
      }
      if (layer.children.length && el.isConnected) el.append(layer);
    } catch (e) { console.warn("contact links", e); }
  }

  /* ---------- side panel ---------- */
  function togglePanel(which, forceOpen) {
    const p = byId("rdPanel");
    if (which === null || (!forceOpen && S.panel === which && !p.hidden)) { p.hidden = true; S.panel = null; byId("rdSearchBtn").classList.remove("on"); byId("rdMarksBtn").classList.remove("on"); byId("rdTocBtn").classList.remove("on"); return; }
    S.panel = which; p.hidden = false; p.classList.remove("compact"); byId("rdBars").classList.remove("away"); renderPanel();
    byId("rdSearchBtn").classList.toggle("on", which === "search"); byId("rdMarksBtn").classList.toggle("on", which === "marks"); byId("rdTocBtn").classList.toggle("on", which === "toc");
  }
  function renderPanel() {
    const p = byId("rdPanel");
    if (S.panel === "search") {
      p.innerHTML = `<div class="rd-find"><input id="rdQ" type="search" placeholder="Search inside this manual" autocomplete="off" aria-label="Search inside this manual" value="${esc(S.q)}">
        <button type="button" id="rdPrev" aria-label="Previous result">‹</button><button type="button" id="rdNext" aria-label="Next result">›</button>
        <button type="button" id="rdPx" aria-label="Close search">Done</button></div>
        <div class="rd-info" id="rdInfo"></div><div class="rd-results" id="rdResults"></div>`;
      const q = byId("rdQ"); let t = 0;
      q.addEventListener("input", () => { clearTimeout(t); p.classList.remove("compact"); t = setTimeout(() => runSearch(q.value), 250); });
      q.addEventListener("focus", () => p.classList.remove("compact"));
      q.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); if (S.results.length) pickResult(S.ri < 0 ? 0 : S.ri + 1); } });
      byId("rdPrev").onclick = () => S.results.length && pickResult(S.ri < 0 ? S.results.length - 1 : S.ri - 1);
      byId("rdNext").onclick = () => S.results.length && pickResult(S.ri + 1);
      byId("rdPx").onclick = () => { S.q = ""; S.words = []; refreshMarks(); togglePanel(null); };
      byId("rdResults").onclick = (e) => { const b = e.target.closest(".rd-res"); if (b) pickResult(+b.dataset.k); };
      if (S.q) { runSearch(S.q).then(() => { if (S.ri >= 0) pickResult(S.ri); }); } else setTimeout(() => q.focus(), 30);
    } else if (S.panel === "toc") {
      p.innerHTML = `<div class="rd-find"><input id="rdTq" type="search" placeholder="Filter the contents" autocomplete="off" aria-label="Filter the contents"><button type="button" id="rdPx">Done</button></div><div class="rd-toc" id="rdTocList"></div>`;
      const list = byId("rdTocList");
      const fill = (q) => {
        const w = words(q);
        const rows = (S.toc || []).map((t, i) => ({ t, i })).filter(({ t }) => !w.length || w.every((x) => t.t.toLowerCase().includes(x)));
        list.innerHTML = rows.length ? rows.map(({ t, i }) => `<button type="button" class="rd-t d${Math.min(t.d, 3)}" data-i="${i}"><span>${esc(t.t)}</span><em>${t.page + 1}</em></button>`).join("") : `<p class="rd-empty">Nothing in the contents matches that.</p>`;
      };
      fill("");
      byId("rdTq").addEventListener("input", (e) => fill(e.target.value));
      byId("rdPx").onclick = () => togglePanel(null);
      list.onclick = (e) => { const b = e.target.closest(".rd-t"); if (!b) return; const t = S.toc[+b.dataset.i]; togglePanel(null); jump(t); };
    } else if (S.panel === "marks") {
      const bm = S.bm.length ? S.bm.map((b) => `<div class="rd-row" data-id="${b.id}"><button type="button" class="go" data-page="${b.page}"><b>${esc(b.label)}</b>${b.label === "Page " + (b.page + 1) ? "" : `<span>Page ${b.page + 1}</span>`}</button><button type="button" class="ren" data-ren="${b.id}" aria-label="Rename bookmark">Rename</button><button type="button" class="del" data-delbm="${b.id}" aria-label="Delete bookmark">✕</button></div>`).join("")
        : `<p class="rd-empty">No bookmarks yet. Tap the bookmark at the top to save the page you're on.</p>`;
      const hl = S.hl.length ? [...S.hl].sort((a, b) => a.page - b.page || a.t - b.t).map((h) => `<div class="rd-row" data-id="${h.id}"><button type="button" class="go" data-page="${h.page}" data-hl="${h.id}"><i style="background:${COLORS[h.color] || COLORS.yellow}"></i><span class="tx">${esc((h.text || "Highlight").slice(0, 140))}</span><span>Page ${h.page + 1}</span></button><button type="button" class="del" data-delhl="${h.id}" aria-label="Delete highlight">✕</button></div>`).join("")
        : `<p class="rd-empty">No highlights yet. Press and hold on some text, drag to select it, then choose a colour.</p>`;
      p.innerHTML = `<div class="rd-head"><b>Bookmarks</b><button type="button" id="rdPx">Done</button></div>${bm}<div class="rd-head"><b>Highlights</b></div>${hl}<p class="rd-note">Saved on this device only.</p>`;
      byId("rdPx").onclick = () => togglePanel(null);
      p.onclick = (e) => {
        const g = e.target.closest(".go"), d1 = e.target.closest("[data-delbm]"), d2 = e.target.closest("[data-delhl]"), rn = e.target.closest("[data-ren]");
        if (g) { togglePanel(null); goTo(+g.dataset.page); }
        else if (d1) { S.bm = S.bm.filter((b) => b.id !== d1.dataset.delbm); persist(); markBookmarks(); updateBm(); renderPanel(); }
        else if (d2) removeHighlight(d2.dataset.delhl);
        else if (rn) { const b = S.bm.find((x) => x.id === rn.dataset.ren); const n = b && prompt("Name this bookmark", b.label); if (n && n.trim()) { b.label = n.trim().slice(0, 60); persist(); renderPanel(); } }
      };
    }
  }

  window.WRReader = { open, close, isOpen: () => isOpen, find: findContacts };
})();
