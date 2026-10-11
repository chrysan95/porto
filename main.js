(() => {
  "use strict";

  /* ---------- Config ---------- */
  const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const REST_TILT = -4;      // envelope resting tilt (deg)
  const SLOT_TILT = 2;       // letter tilt in About (deg)
  const HANDOFF = 0.84;      // hero progress where the letter leaves the envelope scene
  const ZOOM_MAX = 7;        // how much the red band grows
  const FOCUS = [1100, 580]; // zoom focus inside the 1920x1080 design frame
  const REST_P = 0.004;      // hero progress below which the envelope can be spun
  const RED_P = 0.7;         // hero progress where the page turns red

  // Band shapes in 1920x1080 design-frame coordinates (traced from the design)
  const BAND = [[-2000, 1768], [3800, -923.6], [3800, -496.6], [-2000, 2177]];
  const LIGHT = [[-2000, 2300], [-362, 1421], [10, 1080], [195, 910], [570, 910], [1580, 328],
                 [1780, 165], [1845, 262], [2328, -240], [3800, -1200], [3800, 2400], [-2000, 2400]];

  /* ---------- Helpers ---------- */
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const seg = (p, a, b) => clamp((p - a) / (b - a));
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const norm = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const root = document.documentElement;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const makePh = (text, cls = "") => el("div", (cls + " img-ph").trim(), text);
  const activate = (list, i, cls = "is-on") => list.forEach((n, k) => n.classList.toggle(cls, k === i));
  const poke = () => (lastInteract = performance.now());
  const atRest = (p = heroProgress(scrollY)) => p <= REST_P;

  // one row of dot buttons; returns the buttons
  function makeDots(wrap, n, cls, label, onPick) {
    wrap.innerHTML = "";
    return Array.from({ length: n }, (_, k) => {
      const d = el("button", cls);
      d.type = "button";
      d.setAttribute("aria-label", `${label} ${k + 1}`);
      d.addEventListener("click", () => onPick(k));
      wrap.appendChild(d);
      return d;
    });
  }

  // horizontal swipe → onSwipe(+1 | -1)
  function onSwipe(target, cb) {
    let sx = null;
    target.addEventListener("pointerdown", (e) => (sx = e.clientX));
    target.addEventListener("pointercancel", () => (sx = null));
    target.addEventListener("pointerup", (e) => {
      if (sx === null) return;
      const dx = e.clientX - sx; sx = null;
      if (Math.abs(dx) > 40) cb(dx < 0 ? 1 : -1);
    });
  }

  // PDF: documents and rendered pages are cached, so each page renders once
  const pdfDocs = {}, pdfPages = {};
  function pdfDoc(url) {
    if (!pdfDocs[url]) {
      const lib = window.pdfjsLib;
      if (!lib) return Promise.reject(new Error("pdf.js not loaded"));
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      pdfDocs[url] = lib.getDocument(url).promise;
      pdfDocs[url].catch(() => delete pdfDocs[url]);
    }
    return pdfDocs[url];
  }
  function pdfPage(url, n) {
    const key = `${url}#${n}`;
    if (!pdfPages[key]) {
      pdfPages[key] = (async () => {
        const page = await (await pdfDoc(url)).getPage(n);
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: Math.min(3, 2400 / base.width) });
        const canvas = el("canvas");
        canvas.width = Math.round(vp.width);
        canvas.height = Math.round(vp.height);
        await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
        const links = (await page.getAnnotations())
          .filter((a) => a.subtype === "Link" && (a.url || a.unsafeUrl))
          .map((a) => {
            const [x1, y1, x2, y2] = vp.convertToViewportRectangle(a.rect);
            return {
              href: a.url || a.unsafeUrl,
              left: (Math.min(x1, x2) / vp.width) * 100,
              top: (Math.min(y1, y2) / vp.height) * 100,
              width: (Math.abs(x2 - x1) / vp.width) * 100,
              height: (Math.abs(y2 - y1) / vp.height) * 100,
            };
          });
        return { canvas, links, ratio: vp.width / vp.height };
      })();
      pdfPages[key].catch(() => delete pdfPages[key]);
    }
    return pdfPages[key];
  }

  /* ---------- Elements ---------- */
  const hero = $("#home"), about = $("#about"), nav = $("#nav"), stage = $("#stage");
  const envWrap = $("#envWrap"), envHit = $("#envHit"), env = $("#env"), flap = $("#flap");
  const seal = $("#seal"), sealL = $(".seal-l"), sealR = $(".seal-r");
  const sceneLetter = $("#sceneLetter"), fly = $("#flyLetter"), slot = $("#letterSlot"), slotPaper = $("#slotPaper");
  const PDF_URL = slot.dataset.pdf || slot.getAttribute("href");
  const hint = $("#hint");
  const shadowShape = $("#envShadow"), edgeTop = $("#edgeTop");
  const SEAL_PATHS = ["assets/textures/seal.png", "assets/textures/Seal.png", "assets/textures/seal.PNG",
                      "assets/textures/Seal.PNG", "assets/images/seal.png", "assets/seal.png"];
  const band = $("#band"), bandLight = $("#bandLight");
  const navLinks = $$(".nav a");
  const sections = navLinks.map((a) => document.querySelector(a.getAttribute("href")));

  /* ---------- State ---------- */
  let vw = 0, vh = 0, navH = 0, W = 0, H = 0, T = 0, lr = 1.4142;
  let rx = 0, ry = 0, vx = 0, vy = 0;
  let dragging = false, moved = 0, lastX = 0, lastY = 0, suppressClick = false;
  let lastInteract = performance.now();
  let A = null, lastP = -1, dirty = true, anim = null, sy = scrollY, lastShadow = "";

  function measure() {
    vw = innerWidth; vh = innerHeight;
    W = envWrap.offsetWidth; H = envWrap.offsetHeight; T = W * 0.022;
    navH = nav.offsetHeight;
    root.style.setProperty("--nav-h", navH + "px");
    A = null; dirty = true;
  }

  const heroRange = () => Math.max(1, hero.offsetHeight - vh);
  const heroProgress = (y) => clamp((y - hero.offsetTop) / heroRange());

  /* ---------- Red band ---------- */
  function renderBand(p) {
    const e = ease(seg(p, 0.55, 0.86));
    const k = lerp(1, ZOOM_MAX, e);
    const s0 = Math.max(vw / 1920, vh / 1080), s = s0 * k;
    const ox = (vw - 1920 * s0) / 2, oy = (vh - 1080 * s0) / 2;
    const fx = lerp(ox + FOCUS[0] * s0, vw / 2, e);
    const fy = lerp(oy + FOCUS[1] * s0, vh / 2, e);
    const tx = fx - FOCUS[0] * s, ty = fy - FOCUS[1] * s;
    const poly = (pts) => "polygon(" + pts.map(([x, y]) => `${(tx + x * s).toFixed(1)}px ${(ty + y * s).toFixed(1)}px`).join(",") + ")";
    band.style.clipPath = poly(BAND);
    bandLight.style.clipPath = poly(LIGHT);
  }

  /* ---------- Envelope + letter inside the 3D scene ---------- */
  function renderEnv(p) {
    // flap opens, then tucks behind the letter
    const f = ease(seg(p, 0.12, 0.36));
    const fz = lerp(T / 2 + 1, -T / 2 - 2, seg(f, 0.6, 1));
    flap.style.transform = `translateZ(${fz}px) rotateX(${f * 180}deg)`;
    flap.classList.toggle("open", f > 0.97);
    stage.classList.toggle("lifted", f > 0.02);
    edgeTop.style.visibility = f > 0.005 ? "hidden" : "visible";

    // letter rises
    const l = ease(seg(p, 0.34, 0.6));
    const Lw = sceneLetter.offsetWidth, Lh = Lw * lr;
    const top = lerp(H * 0.03, Math.min(-W * 0.2, H * 0.97 - Lh), l);

    // envelope drops away while the letter stays put on screen
    const d = ease(seg(p, 0.6, 0.84));
    const drop = d * (vh * 0.55 + H * 1.3);
    const r = (-REST_TILT * Math.PI) / 180;
    const lx = drop * Math.sin(r), ly = -drop * Math.cos(r);
    const over = Math.max(0, top + ly + Lh - H * 0.985);

    sceneLetter.style.transform = `translate3d(${lx.toFixed(2)}px, ${(top + ly).toFixed(2)}px, 0)`;
    sceneLetter.style.clipPath = `inset(0 0 ${over.toFixed(2)}px 0)`;
    sceneLetter.style.visibility = p >= HANDOFF ? "hidden" : "visible";

    envWrap.style.transform =
      `translate(-50%, -50%) translate(${(l * W * 0.03).toFixed(2)}px, ${(l * W * 0.05 + drop).toFixed(2)}px) rotate(${REST_TILT}deg)`;
    envWrap.style.setProperty("--eo", (1 - seg(p, 0.66, 0.84)).toFixed(3));

    // titles
    const fade = 1 - seg(p, 0.5, 0.7);
    $$(".title, .year").forEach((el) => (el.style.opacity = fade));
    hint.style.opacity = 1 - seg(p, 0, 0.03);
  }

  /* ---------- Dynamic shadow (follows the envelope's rotation) ---------- */
  function renderShadow(ax, ay) {
    const a = ax * Math.PI / 180, b = ay * Math.PI / 180;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
    const D = W * 0.32, lx = 0.07, ly = 0.13;
    const pts = [[-W / 2, -H / 2], [W / 2, -H / 2], [W / 2, H / 2], [-W / 2, H / 2]].map(([x, y]) => {
      const x1 = x * cb, z1 = -x * sb;          // rotateY
      const y2 = y * ca - z1 * sa;               // rotateX
      const z2 = y * sa + z1 * ca;
      const k = Math.max(0, z2 + D);
      return `${(x1 + k * lx + W).toFixed(1)}px ${(y2 + k * ly + H).toFixed(1)}px`;
    });
    const poly = "polygon(" + pts.join(",") + ")";
    if (poly !== lastShadow) { shadowShape.style.clipPath = poly; lastShadow = poly; }
  }

  /* ---------- Letter travelling to the About section ---------- */
  function sceneLetterRect() {
    const r = sceneLetter.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: sceneLetter.offsetWidth };
  }

  function renderLetter(y, p) {
    if (p < HANDOFF) {
      fly.style.visibility = "hidden";
      slotPaper.style.visibility = "hidden";
      if (rx === 0 && ry === 0) A = sceneLetterRect();
      return;
    }
    if (!A) {
      const keep = env.style.transform;
      env.style.transform = "none";
      renderEnv(HANDOFF);
      A = sceneLetterRect();
      renderEnv(p);
      env.style.transform = keep;
    }
    const sH = hero.offsetTop + HANDOFF * heroRange();
    const sD = Math.max(sH + 1, about.offsetTop);
    const t = ease(clamp((y - sH) / (sD - sH)));

    if (t >= 1) {
      fly.style.visibility = "hidden";
      slotPaper.style.visibility = "visible";
      return;
    }
    const r = slot.getBoundingClientRect();
    const w = lerp(A.w, r.width, t);
    const cx = lerp(A.cx, r.left + r.width / 2, t);
    const cy = lerp(A.cy, r.top + r.height / 2, t);
    const rot = lerp(REST_TILT, SLOT_TILT, t);
    fly.style.width = w.toFixed(2) + "px";
    fly.style.transform = `translate(${(cx - w / 2).toFixed(2)}px, ${(cy - (w * lr) / 2).toFixed(2)}px) rotate(${rot.toFixed(3)}deg)`;
    fly.style.visibility = "visible";
    slotPaper.style.visibility = "hidden";
  }

  /* ---------- Navbar ---------- */
  const expSec = $("#experience");
  function renderNav(y, p) {
    const white = y >= expSec.offsetTop - navH * 0.5;
    nav.classList.toggle("on-white", white);
    nav.classList.toggle("on-red", p > RED_P && !white);
    nav.classList.toggle("solid", y >= about.offsetTop - navH);
    let current = -1;
    sections.forEach((s, i) => { if (s && y >= s.offsetTop - vh * 0.4) current = i; });
    navLinks.forEach((a, i) => (i === current ? a.setAttribute("aria-current", "true") : a.removeAttribute("aria-current")));
  }

  /* ---------- Experience timeline ---------- */
  const expItems = $$(".exp-item"), tlSegs = $$(".tl-seg");
  const pinMQ = matchMedia("(min-width: 901px) and (min-height: 621px)");
  let expIdx = 0;
  const expRange = () => Math.max(1, expSec.offsetHeight - vh);
  function setExp(i) {
    if (i === expIdx) return;
    expIdx = i;
    activate(expItems, i, "is-active");
    activate(tlSegs, i, "is-active");
  }
  function renderExp(y) {
    if (!pinMQ.matches) return;
    const prog = clamp((y - expSec.offsetTop) / expRange());
    setExp(Math.min(expItems.length - 1, Math.floor(prog * expItems.length)));
  }
  activate(tlSegs, 0, "is-active");
  tlSegs.forEach((b, i) => b.addEventListener("click", () =>
    scrollToY(expSec.offsetTop + ((i + 0.5) / expItems.length) * expRange())));

  /* ---------- Galleries ---------- */
  $$("[data-gallery]").forEach((g) => {
    const frame = g.querySelector(".gallery-frame");
    const slides = [...g.querySelectorAll(".slide")];
    const dotsWrap = g.querySelector(".g-dots");
    let i = 0, hover = false;
    const dots = makeDots(dotsWrap, slides.length, "g-dot", "Photo", (k) => show(k));
    function show(k) {
      i = (k + slides.length) % slides.length;
      activate(slides, i);
      activate(dots, i);
    }
    g.querySelector(".g-prev").addEventListener("click", () => show(i - 1));
    g.querySelector(".g-next").addEventListener("click", () => show(i + 1));
    g.addEventListener("mouseenter", () => (hover = true));
    g.addEventListener("mouseleave", () => (hover = false));
    onSwipe(frame, (dir) => show(i + dir));
    if (slides.length < 2) g.querySelector(".gallery-ctrl").hidden = true;
    show(0);
    if (!reduce && slides.length > 1) {
      setInterval(() => {
        const item = g.closest(".exp-item");
        const visible = !pinMQ.matches || (item && item.classList.contains("is-active"));
        if (!hover && visible && !document.hidden) show(i + 1);
      }, 4000);
    }
  });

  /* ---------- Loop ---------- */
  function frame(now) {
    const target = scrollY;
    sy = reduce ? target : sy + (target - sy) * 0.22;
    if (Math.abs(target - sy) < 0.5) sy = target;
    const y = sy, p = heroProgress(y);

    if (!dragging) {
      if (!atRest(p)) {
        rx = lerp(norm(rx), 0, 0.15); ry = lerp(norm(ry), 0, 0.15); vx = vy = 0;
        if (Math.abs(rx) < 0.02) rx = 0;
        if (Math.abs(ry) < 0.02) ry = 0;
      } else {
        rx += vx; ry += vy; vx *= 0.94; vy *= 0.94;
      }
    }
    let ix = 0, iy = 0;
    if (!reduce && !dragging && atRest(p)) {
      const idle = clamp((now - lastInteract - 1500) / 1500);
      ix = Math.sin(now / 1700) * 5 * idle;
      iy = Math.sin(now / 2300) * 10 * idle;
    }
    env.style.transform = `rotateX(${(rx + ix).toFixed(3)}deg) rotateY(${(ry + iy).toFixed(3)}deg)`;
    renderShadow(rx + ix, ry + iy);
    env.style.setProperty("--sh", (((((ry + iy) % 360) + 360) % 360) / 360).toFixed(3));

    if (dirty || p !== lastP) {
      renderBand(p);
      renderEnv(p);
      lastP = p; dirty = false;
    }
    renderLetter(y, p);
    renderNav(y, p);
    renderExp(target);
    renderSB(target, p);
    requestAnimationFrame(frame);
  }

  /* ---------- Scrolling helpers ---------- */
  function cancelAnim() { if (anim) { cancelAnimationFrame(anim); anim = null; } }
  function animateTo(target, dur) {
    cancelAnim();
    const start = scrollY, dist = target - start;
    if (Math.abs(dist) < 2) return;
    if (reduce) dur = Math.min(dur, 500);
    const t0 = performance.now();
    const step = (now) => {
      const k = clamp((now - t0) / dur);
      scrollTo(0, start + dist * ease(k));
      anim = k < 1 ? requestAnimationFrame(step) : null;
    };
    anim = requestAnimationFrame(step);
  }
  ["wheel", "touchstart", "keydown", "pointerdown"].forEach((ev) =>
    addEventListener(ev, cancelAnim, { passive: true, capture: true }));

  const durFor = (target) => clamp((Math.abs(target - scrollY) / vh) * 320, 450, 1500);
  const scrollToY = (target) => animateTo(target, durFor(target));
  const openEnvelope = () => scrollToY(about.offsetTop);

  navLinks.forEach((a, i) => a.addEventListener("click", (e) => {
    if (!sections[i]) return;
    e.preventDefault();
    scrollToY(sections[i].offsetTop);
    history.replaceState(null, "", a.getAttribute("href"));
  }));

  /* ---------- Slides viewer (projects + secret file) ---------- */
  // <a data-pdf="file.pdf" data-pages="1-2">  (no data-pages = every page)
  // <a data-slides="a.jpg, b.jpg">
  const deck = $("#deck"), deckTrack = $("#deckTrack"), deckDots = $("#deckDots");
  const deckTitle = $("#deckTitle"), deckFrame = $("#deckFrame");
  const deckPrev = $(".deck-prev"), deckNext = $(".deck-next"), deckClose = $(".deck-close");
  let deckIdx = 0, deckN = 0, deckOpener = null, deckDotEls = [];

  function parsePages(str = "") {
    const out = [];
    str.split(",").forEach((part) => {
      const [a, b] = part.trim().split("-").map(Number);
      if (a) for (let n = a; n <= (b || a); n++) out.push(n);
    });
    return out;
  }

  async function deckItems(src) {
    if (!src.dataset.pdf) return (src.dataset.slides || "").split(",").map((x) => x.trim()).filter(Boolean);
    if (src.dataset.pages) return parsePages(src.dataset.pages);
    const doc = await pdfDoc(src.dataset.pdf);
    return Array.from({ length: doc.numPages }, (_, i) => i + 1);
  }

  async function pdfRatio(url, n) {
    const v = (await (await pdfDoc(url)).getPage(n)).getViewport({ scale: 1 });
    return v.width / v.height;
  }

  function setDeckRatio(r) {
    deck.style.setProperty("--ar", r.toFixed(4));
    deckFrame.style.aspectRatio = r.toFixed(4);
  }

  function deckShow(k) {
    deckIdx = clamp(k, 0, deckN - 1);
    deckTrack.style.transform = `translateX(${-100 * deckIdx}%)`;
    [...deckTrack.children].forEach((f, n) => f.toggleAttribute("inert", n !== deckIdx));
    activate(deckDotEls, deckIdx);
    deckDotEls.forEach((d, n) => d.setAttribute("aria-current", String(n === deckIdx)));
    deckPrev.disabled = deckIdx === 0;
    deckNext.disabled = deckIdx === deckN - 1;
  }

  async function fillPdfSlide(fig, url, n, title) {
    try {
      const { canvas, links } = await pdfPage(url, n);
      const wrap = el("div", "deck-page");
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", `${title} slide ${n}`);
      wrap.appendChild(canvas);
      links.forEach((l) => {
        const a = el("a", "deck-link");
        a.href = l.href; a.target = "_blank"; a.rel = "noopener";
        a.setAttribute("aria-label", l.href);
        Object.assign(a.style, { left: l.left + "%", top: l.top + "%", width: l.width + "%", height: l.height + "%" });
        wrap.appendChild(a);
      });
      fig.replaceChildren(wrap);
    } catch (err) {
      console.warn("Slide PDF not loaded:", err);
      fig.replaceChildren(makePh(`${url} (page ${n})`));
    }
    fig.classList.remove("is-loading");
  }

  function imgSlide(fig, src, alt) {
    const img = el("img");
    img.alt = alt;
    img.draggable = false;
    img.addEventListener("error", () => img.replaceWith(makePh(src)), { once: true });
    img.src = src;
    fig.appendChild(img);
  }

  let deckBusy = false;
  async function openDeck(src) {
    if (deckBusy || !deck.hidden) return;
    deckBusy = true;
    const pdfUrl = src.dataset.pdf;
    let items = [], ratio = 16 / 9;
    try {
      items = await deckItems(src);
      if (pdfUrl && items.length) ratio = await pdfRatio(pdfUrl, items[0]);
    } catch (err) {
      console.warn("Slides not loaded:", err);
    }
    deckBusy = false;
    if (!items.length) {
      // fall back to the link's own target (e.g. the raw PDF)
      const href = src.getAttribute("href");
      if (href && href !== "#") window.open(href, "_blank", "noopener");
      return;
    }
    const title = src.dataset.title || "";

    deckTitle.textContent = title;
    deckTrack.innerHTML = "";
    setDeckRatio(ratio);
    items.forEach((item, k) => {
      const fig = el("figure", "deck-slide");
      fig.setAttribute("aria-label", `Slide ${k + 1} of ${items.length}`);
      deckTrack.appendChild(fig);
      if (pdfUrl) { fig.classList.add("is-loading"); fillPdfSlide(fig, pdfUrl, item, title); }
      else imgSlide(fig, item, `${title} slide ${k + 1}`);
    });
    deckN = items.length;
    deckDotEls = makeDots(deckDots, deckN, "deck-dot", "Page", (k) => deckShow(k));
    deckDots.hidden = deckN < 2;

    deckTrack.style.transition = "none";
    deckShow(0);
    void deckTrack.offsetWidth;
    deckTrack.style.transition = "";

    cancelAnim();
    deckOpener = src;
    deck.hidden = false;
    root.classList.add("deck-open");
    deckClose.focus({ preventScroll: true });
  }

  function closeDeck() {
    if (deck.hidden) return;
    deck.hidden = true;
    root.classList.remove("deck-open");
    if (deckOpener) deckOpener.focus({ preventScroll: true });
  }

  $$("a[data-pdf], a[data-slides]").forEach((src) => {
    src.addEventListener("click", (e) => { e.preventDefault(); openDeck(src); });
    // start rendering on hover/focus so the viewer opens instantly
    if (src.dataset.pdf) {
      const warm = () => deckItems(src)
        .then((pages) => pages.forEach((n) => pdfPage(src.dataset.pdf, n).catch(() => {})))
        .catch(() => {});
      src.addEventListener("pointerenter", warm, { once: true });
      src.addEventListener("focus", warm, { once: true });
    }
  });
  deck.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeDeck));
  deckPrev.addEventListener("click", () => deckShow(deckIdx - 1));
  deckNext.addEventListener("click", () => deckShow(deckIdx + 1));
  onSwipe(deckFrame, (dir) => deckShow(deckIdx + dir));
  document.addEventListener("keydown", (e) => {
    if (deck.hidden) return;
    if (e.key === "Escape") { e.preventDefault(); closeDeck(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); deckShow(deckIdx - 1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); deckShow(deckIdx + 1); }
    else if (e.key === "Tab") {
      const f = [...deck.querySelectorAll("button:not([disabled]), a[href]")].filter((n) => !n.closest("[inert]"));
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!deck.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    }
  });

  /* ---------- Custom scrollbar ---------- */
  const sb = $("#sb"), sbThumb = $("#sbThumb"), sbSewn = $("#sbSewn");
  const sbOff = matchMedia("(pointer: coarse)");
  const SB_PAD = 8, SB_MIN = 48;
  let sbDrag = null, lastSB = "";

  function sbGeom() {
    const docH = Math.max(root.scrollHeight, document.body.scrollHeight);
    const max = Math.max(1, docH - vh);
    const trackH = Math.max(1, vh - SB_PAD * 2);
    const th = clamp((trackH * vh) / docH, SB_MIN, trackH);
    return { max, trackH, th, room: Math.max(1, trackH - th) };
  }

  function renderSB(y, p) {
    if (sbOff.matches) return;
    const g = sbGeom();
    const top = g.room * clamp(y / g.max);
    const key = g.th.toFixed(1) + "|" + top.toFixed(1);
    if (key !== lastSB) {
      sbThumb.style.height = g.th.toFixed(1) + "px";
      sbThumb.style.transform = `translateY(${top.toFixed(1)}px)`;
      sbSewn.style.height = top.toFixed(1) + "px";
      lastSB = key;
    }
    sb.classList.toggle("on-red", nav.classList.contains("on-red"));
    sb.classList.toggle("on-hero", p <= RED_P);
  }

  function sbStart(e, from) {
    e.preventDefault();
    cancelAnim();
    const g = sbGeom();
    sbDrag = { y: e.clientY, s: from, ratio: g.max / g.room };
    sbThumb.setPointerCapture(e.pointerId);
    sbThumb.classList.add("grabbing");
    root.classList.add("sb-dragging");
  }
  const sbEnd = () => {
    if (!sbDrag) return;
    sbDrag = null;
    sbThumb.classList.remove("grabbing");
    root.classList.remove("sb-dragging");
  };

  // drag the thumb: it stays under the cursor
  sbThumb.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    sbStart(e, scrollY);
  });
  // click the track: jump there, then keep following while held
  sb.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target === sbThumb) return;
    const g = sbGeom();
    const target = clamp((e.clientY - SB_PAD - g.th / 2) / g.room) * g.max;
    scrollTo(0, target);
    sbStart(e, target);
  });
  sbThumb.addEventListener("pointermove", (e) => {
    if (sbDrag) scrollTo(0, sbDrag.s + (e.clientY - sbDrag.y) * sbDrag.ratio);
  });
  sbThumb.addEventListener("lostpointercapture", sbEnd); // fires on pointerup and pointercancel too

  /* ---------- 360° drag ---------- */
  envHit.addEventListener("pointerdown", (e) => {
    poke();
    moved = 0;
    if (!atRest()) return;
    dragging = true; vx = vy = 0;
    lastX = e.clientX; lastY = e.clientY;
    envHit.setPointerCapture(e.pointerId);
    envHit.classList.add("grabbing");
  });
  envHit.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    moved += Math.abs(dx) + Math.abs(dy);
    ry += dx * 0.5; rx -= dy * 0.5;
    vy = dx * 0.5; vx = -dy * 0.5;
    poke();
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    envHit.classList.remove("grabbing");
    if (moved > 6) suppressClick = true;
    poke();
  };
  envHit.addEventListener("pointerup", endDrag);
  envHit.addEventListener("pointercancel", endDrag);
  envHit.addEventListener("click", () => {
    if (suppressClick) { suppressClick = false; return; }
    openEnvelope();
  });
  const SPIN = { ArrowLeft: [0, -20], ArrowRight: [0, 20], ArrowUp: [20, 0], ArrowDown: [-20, 0] };
  envHit.addEventListener("keydown", (e) => {
    poke();
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openEnvelope(); return; }
    const spin = SPIN[e.key];
    if (!spin || !atRest()) return;
    e.preventDefault();
    rx += spin[0]; ry += spin[1];
  });

  /* ---------- Image placeholders ---------- */
  $$("img[data-ph]").forEach((img) => {
    const fail = () => {
      const ph = makePh(img.dataset.ph, img.className);
      if (img.id) ph.id = img.id;
      img.replaceWith(ph);
    };
    if (img.complete && img.naturalWidth === 0) fail();
    else img.addEventListener("error", fail, { once: true });
  });
  (function loadSeal(i = 0) {
    if (i >= SEAL_PATHS.length) {
      seal.classList.add("missing");
      console.warn("Seal image not found. Tried:", SEAL_PATHS.join(", "));
      return;
    }
    const probe = new Image();
    probe.onload = () => { sealL.src = sealR.src = SEAL_PATHS[i]; seal.classList.remove("missing"); };
    probe.onerror = () => loadSeal(i + 1);
    probe.src = SEAL_PATHS[i] + "?v=" + Date.now();
  })();

  /* ---------- PDF → letter image ---------- */
  async function loadLetter() {
    try {
      const { canvas, ratio } = await pdfPage(PDF_URL, 1);
      const url = canvas.toDataURL("image/jpeg", 0.92);
      $$(".letter-img").forEach((img) => (img.src = url));
      lr = 1 / ratio;
      root.style.setProperty("--lr", lr.toFixed(4));
      root.classList.add("pdf-ok");
      measure();
    } catch (err) {
      console.warn("Letter PDF not loaded:", err);
    }
  }

  /* ---------- Init ---------- */
  measure();
  addEventListener("resize", measure);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
  addEventListener("load", () => { measure(); loadLetter(); });
  requestAnimationFrame(frame);
})();
