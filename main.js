(() => {
  "use strict";

  /* ---------- Config ---------- */
  const PDF_URL = "assets/files/secret-file.pdf";
  const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const REST_TILT = -4;      // envelope resting tilt (deg)
  const SLOT_TILT = 2;       // letter tilt in About (deg)
  const HANDOFF = 0.84;      // hero progress where the letter leaves the envelope scene
  const ZOOM_MAX = 7;        // how much the red band grows
  const FOCUS = [1100, 580]; // zoom focus inside the 1920x1080 design frame

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

  /* ---------- Elements ---------- */
  const hero = $("#home"), about = $("#about"), nav = $("#nav"), stage = $("#stage");
  const envWrap = $("#envWrap"), envHit = $("#envHit"), env = $("#env"), flap = $("#flap");
  const seal = $("#seal"), sealL = $(".seal-l"), sealR = $(".seal-r");
  const sceneLetter = $("#sceneLetter"), fly = $("#flyLetter"), slot = $("#letterSlot"), slotPaper = $("#slotPaper");
  const hint = $("#hint");
  const shadowShape = $("#envShadow"), edgeTop = $("#edgeTop");
  const SEAL_PATHS = ["assets/textures/seal.png", "assets/textures/Seal.png", "assets/textures/seal.PNG",
                      "assets/textures/Seal.PNG", "assets/images/seal.png", "assets/seal.png"];
  const band = $("#band"), bandLight = $("#bandLight");
  const navLinks = $$(".nav a");
  const sections = navLinks.map((a) => document.querySelector(a.getAttribute("href")));

  /* ---------- State ---------- */
  let vw = 0, vh = 0, W = 0, H = 0, T = 0, lr = 1.4142;
  let rx = 0, ry = 0, vx = 0, vy = 0;
  let dragging = false, moved = 0, lastX = 0, lastY = 0, suppressClick = false;
  let lastInteract = performance.now();
  let A = null, lastP = -1, dirty = true, anim = null, sy = scrollY, lastShadow = "";

  function measure() {
    vw = innerWidth; vh = innerHeight;
    W = envWrap.offsetWidth; H = envWrap.offsetHeight; T = W * 0.022;
    root.style.setProperty("--nav-h", nav.offsetHeight + "px");
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
    // seal stays stuck to the flap
    sealL.style.transform = sealR.style.transform = "none";
    seal.style.opacity = 1;

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
    const white = y >= expSec.offsetTop - nav.offsetHeight * 0.5;
    nav.classList.toggle("on-white", white);
    nav.classList.toggle("on-red", p > 0.7 && !white);
    nav.classList.toggle("solid", y >= about.offsetTop - nav.offsetHeight);
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
    expItems.forEach((el, k) => el.classList.toggle("is-active", k === i));
    tlSegs.forEach((el, k) => el.classList.toggle("is-active", k === i));
  }
  function renderExp(y) {
    if (!pinMQ.matches) return;
    const prog = clamp((y - expSec.offsetTop) / expRange());
    setExp(Math.min(expItems.length - 1, Math.floor(prog * expItems.length)));
  }
  tlSegs.forEach((seg, i) => {
    if (i === 0) seg.classList.add("is-active");
    seg.addEventListener("click", () => {
      const t = expSec.offsetTop + ((i + 0.5) / expItems.length) * expRange();
      animateTo(t, durFor(t));
    });
  });

  /* ---------- Galleries ---------- */
  $$("[data-gallery]").forEach((g) => {
    const frame = g.querySelector(".gallery-frame");
    const slides = [...g.querySelectorAll(".slide")];
    const dotsWrap = g.querySelector(".g-dots");
    let i = 0, hover = false;
    const dots = slides.map((_, k) => {
      const d = document.createElement("button");
      d.type = "button"; d.className = "g-dot"; d.setAttribute("aria-label", `Photo ${k + 1}`);
      d.addEventListener("click", () => show(k));
      dotsWrap.appendChild(d);
      return d;
    });
    function show(k) {
      i = (k + slides.length) % slides.length;
      slides.forEach((s, n) => s.classList.toggle("is-on", n === i));
      dots.forEach((d, n) => d.classList.toggle("is-on", n === i));
    }
    g.querySelector(".g-prev").addEventListener("click", () => show(i - 1));
    g.querySelector(".g-next").addEventListener("click", () => show(i + 1));
    g.addEventListener("mouseenter", () => (hover = true));
    g.addEventListener("mouseleave", () => (hover = false));
    let sx = null;
    frame.addEventListener("pointerdown", (e) => (sx = e.clientX));
    frame.addEventListener("pointerup", (e) => {
      if (sx === null) return;
      const dx = e.clientX - sx; sx = null;
      if (Math.abs(dx) > 40) show(i + (dx < 0 ? 1 : -1));
    });
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
      if (p > 0.004) {
        rx = lerp(norm(rx), 0, 0.15); ry = lerp(norm(ry), 0, 0.15); vx = vy = 0;
        if (Math.abs(rx) < 0.02) rx = 0;
        if (Math.abs(ry) < 0.02) ry = 0;
      } else {
        rx += vx; ry += vy; vx *= 0.94; vy *= 0.94;
      }
    }
    let ix = 0, iy = 0;
    if (!reduce && !dragging && p <= 0.004) {
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
    renderExp(scrollY);
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
  const openEnvelope = () => animateTo(about.offsetTop, durFor(about.offsetTop));

  navLinks.forEach((a) => a.addEventListener("click", (e) => {
    const target = document.querySelector(a.getAttribute("href"));
    if (!target) return;
    e.preventDefault();
    animateTo(target.offsetTop, durFor(target.offsetTop));
    history.replaceState(null, "", a.getAttribute("href"));
  }));

  /* ---------- 360° drag ---------- */
  envHit.addEventListener("pointerdown", (e) => {
    lastInteract = performance.now();
    moved = 0;
    if (heroProgress(scrollY) > 0.004) return;
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
    lastInteract = performance.now();
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    envHit.classList.remove("grabbing");
    if (moved > 6) suppressClick = true;
    lastInteract = performance.now();
  };
  envHit.addEventListener("pointerup", endDrag);
  envHit.addEventListener("pointercancel", endDrag);
  envHit.addEventListener("click", () => {
    if (suppressClick) { suppressClick = false; return; }
    openEnvelope();
  });
  envHit.addEventListener("keydown", (e) => {
    lastInteract = performance.now();
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openEnvelope(); }
    if (heroProgress(scrollY) > 0.004) return;
    if (e.key === "ArrowLeft") { ry -= 20; e.preventDefault(); }
    if (e.key === "ArrowRight") { ry += 20; e.preventDefault(); }
    if (e.key === "ArrowUp") { rx += 20; e.preventDefault(); }
    if (e.key === "ArrowDown") { rx -= 20; e.preventDefault(); }
  });

  /* ---------- Image placeholders ---------- */
  $$("img[data-ph]").forEach((img) => {
    const fail = () => {
      const ph = document.createElement("div");
      ph.className = img.className + " img-ph";
      ph.id = img.id;
      ph.textContent = img.dataset.ph;
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
  async function loadPDF() {
    try {
      const lib = window.pdfjsLib;
      if (!lib) return;
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      const pdf = await lib.getDocument(PDF_URL).promise;
      const page = await pdf.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(4, 1800 / base.width);
      const vp = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
      const url = canvas.toDataURL("image/jpeg", 0.92);
      $$(".letter-img").forEach((img) => (img.src = url));
      lr = vp.height / vp.width;
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
  addEventListener("load", () => { measure(); loadPDF(); });
  requestAnimationFrame(frame);
})();
