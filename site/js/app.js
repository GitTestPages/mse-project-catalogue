(function () {
  const ALL = (window.PROJECTS || []).slice();
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (id) => document.getElementById(id);

  const el = {
    body: document.body,
    main: document.querySelector("main"),
    header: document.querySelector(".top"),
    stage: $("stage"),
    space: $("space-view"),
    listView: $("list-view"),
    list: $("list"),
    empty: $("empty"),
    focusLevel: $("focus-level"),
    focusTitle: $("focus-title"),
    focusPeople: $("focus-people"),
    focusOpen: $("focus-open"),
    focusBox: document.querySelector(".focus"),
    countNow: $("count-now"),
    countAll: $("count-all"),
    supervisor: $("f-supervisor"),
    search: $("f-search"),
    detail: $("detail"),
    detailBody: $("detail-body"),
    detailScroll: $("detail-scroll"),
  };

  const state = {
    level: "all",
    supervisor: "",
    query: "",
    items: ALL,
    pos: 0,
    target: 0,
    shown: -1,
    view: "space",
    openId: null,
    pushedHash: false,
    returnFocus: null,
  };

  // ---------- helpers ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = (n) => String(n).padStart(2, "0");
  const levelText = (p) => (/^(master|bachelor)$/i.test(p.levelText) ? `${p.levelText} project` : p.levelText);
  const joinNames = (names) => names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const people = (p) => joinNames(p.supervisors.map((s) => s.name));
  const pct = (n) => `${n}%`;

  // The project figure, rebuilt from the slide: pictures (with their crop) and
  // any labels drawn on top, positioned in percent of the figure's box.
  function figureHTML(p, eager) {
    const f = p.figure;
    if (!f) return "";
    const items = f.items.map((it) => {
      const box = `left:${pct(it.x)};top:${pct(it.y)};width:${pct(it.w)};height:${pct(it.h)}`;
      if (it.type === "img") {
        let img = "";
        if (it.crop) {
          const c = it.crop, kw = 1 - c.l - c.r, kh = 1 - c.t - c.b;
          img = `width:${pct(100 / kw)};height:${pct(100 / kh)};left:${pct(-c.l / kw * 100)};top:${pct(-c.t / kh * 100)}`;
        }
        return `<span class="fig-img" style="${box}"><img src="${esc(it.src)}" alt="" draggable="false" loading="${eager ? "eager" : "lazy"}"${img ? ` style="${img}"` : ""}></span>`;
      }
      return `<span class="fig-text" style="${box};font-size:${it.size}cqw;${it.color ? `color:${esc(it.color)};` : ""}${it.bold ? "font-weight:700;" : ""}text-align:${it.align}">${esc(it.text).replace(/\n/g, "<br>")}</span>`;
    }).join("");
    return `<span class="fig" style="--ratio:${f.ratio}" role="img" aria-label="${esc(p.caption || `Figure for ${p.title}`)}">${items}</span>`;
  }

  function blocksHTML(blocks) {
    let html = "", list = null;
    const flush = () => { if (list) { html += `<ul>${list}</ul>`; list = null; } };
    for (const b of blocks) {
      if (b.t === "li") {
        const sub = b.sub.map((s) => `<span class="li-sub">${esc(s)}</span>`).join("");
        const head = b.sub.length ? `<span class="li-head">${esc(b.text)}</span>` : esc(b.text);
        list = (list || "") + `<li${b.lvl ? ` class="lvl${b.lvl}"` : ""}>${head}${sub}</li>`;
      } else {
        flush();
        html += `<p>${esc(b.text)}</p>`;
      }
    }
    flush();
    return html;
  }

  const sectionText = (p) => p.sections.flatMap((s) => s.blocks.flatMap((b) => [b.text, ...(b.sub || [])])).join(" ");
  const mailto = (emails, p) =>
    `mailto:${emails.join(",")}?subject=${encodeURIComponent(`Interest in the project "${p.title}"`)}`;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
  };

  // ---------- filters ----------
  const supervisors = [...new Set(ALL.flatMap((p) => p.supervisors.map((s) => s.name)))].sort((a, b) =>
    a.split(" ").pop().localeCompare(b.split(" ").pop()));
  el.supervisor.insertAdjacentHTML("beforeend", supervisors.map((n) => `<option>${esc(n)}</option>`).join(""));

  function haystack(p) {
    return [p.title, p.subtitle, p.caption, p.levelText, sectionText(p), ...p.collaboration, ...p.tags,
      ...p.supervisors.map((s) => `${s.name} ${s.affiliation}`), ...p.level].join(" ").toLowerCase();
  }

  // Level buttons come from the data, so "Special course" appears only if used.
  const LEVELS = ["Bachelor", "Master", "Special course"].filter((l) => ALL.some((p) => p.level.includes(l)));
  document.querySelector(".seg").insertAdjacentHTML("beforeend",
    LEVELS.map((l) => `<button type="button" data-level="${esc(l)}" aria-pressed="false">${esc(l)}</button>`).join(""));
  ALL.forEach((p) => (p._text = haystack(p)));

  function applyFilters() {
    const words = state.query.toLowerCase().split(/\s+/).filter(Boolean);
    const current = state.items[Math.round(state.target)];
    state.items = ALL.filter((p) =>
      (state.level === "all" || p.level.includes(state.level)) &&
      (!state.supervisor || p.supervisors.some((s) => s.name === state.supervisor)) &&
      words.every((w) => p._text.includes(w)));
    const keep = current ? state.items.indexOf(current) : -1;
    state.target = keep >= 0 ? keep : 0;
    state.pos = state.target;
    state.shown = -1;
    renderStage();
    renderList();
    el.empty.hidden = state.items.length > 0;
    el.space.classList.toggle("is-empty", state.items.length === 0);
    el.countAll.textContent = pad(state.items.length);
  }

  document.querySelectorAll("[data-level]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.level = btn.dataset.level;
      document.querySelectorAll("[data-level]").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      applyFilters();
    }));
  el.supervisor.addEventListener("change", () => { state.supervisor = el.supervisor.value; applyFilters(); });
  let searchTimer;
  el.search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = el.search.value; applyFilters(); }, 120);
  });
  $("reset").addEventListener("click", () => {
    state.level = "all"; state.supervisor = ""; state.query = "";
    el.supervisor.value = ""; el.search.value = "";
    document.querySelectorAll("[data-level]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.level === "all")));
    applyFilters();
  });

  // ---------- 3D gallery ----------
  function renderStage() {
    el.stage.innerHTML = state.items.map((p, i) => `
      <div class="card${p.status === "taken" ? " is-taken" : ""}" data-i="${i}" aria-hidden="true">
        <div class="plate">${figureHTML(p, i < 5)}</div>
        <div class="card-foot">
          <span>${pad(i + 1)}</span>
          <span>${esc(p.level.join(" / "))}</span>
        </div>
      </div>`).join("");
    layout(true);
  }

  function spacing() {
    return Math.min(window.innerWidth * 0.3, 460);
  }

  function layout(force) {
    const cards = el.stage.children;
    const sp = spacing();
    for (let i = 0; i < cards.length; i++) {
      const d = i - state.pos;
      const a = Math.abs(d);
      const s = Math.sign(d);
      // Projects already passed tuck in behind, away from the title on the left.
      const past = d < 0;
      const x = s * sp * (past ? 0.62 : 1) * (a < 1 ? a : 1 + (a - 1) * 0.72);
      const z = -a * (past ? 420 : 280);
      const y = a * a * 8;
      const ry = Math.max(-62, Math.min(62, -d * 30));
      const c = cards[i];
      c.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, ${z.toFixed(1)}px) rotateY(${ry.toFixed(2)}deg)`;
      c.style.opacity = a > 4.2 ? 0 : Math.max(0, 1 - a * (past ? 0.6 : 0.24)).toFixed(3);
      c.style.zIndex = String(100 - Math.round(a * 10));
      c.style.setProperty("--focus", Math.max(0, 1 - a).toFixed(3));
      c.style.visibility = a > 4.5 ? "hidden" : "visible";
    }
    const idx = Math.round(state.pos);
    if (idx !== state.shown || force) showFocus(idx);
  }

  function showFocus(idx) {
    const p = state.items[idx];
    state.shown = idx;
    [...el.stage.children].forEach((c, i) => c.classList.toggle("is-focus", i === idx));
    if (!p) {
      el.focusTitle.textContent = "";
      el.focusLevel.textContent = "";
      el.focusPeople.textContent = "";
      el.countNow.textContent = "00";
      return;
    }
    el.focusBox.classList.remove("swap");
    void el.focusBox.offsetWidth;
    el.focusBox.classList.add("swap");
    el.focusLevel.textContent = levelText(p) + (p.status === "taken" ? ", already taken" : "");
    el.focusTitle.textContent = p.title;
    el.focusTitle.classList.toggle("long", p.title.length > 64);
    el.focusPeople.textContent = `Supervised by ${people(p)}` +
      (p.collaboration.length ? `, in collaboration with ${p.collaboration.join(", ")}` : "");
    el.countNow.textContent = pad(idx + 1);
    if (window.Grain) window.Grain.setFocusHue(ALL.indexOf(p));
  }

  function go(n) {
    if (!state.items.length) return;
    state.target = Math.max(0, Math.min(state.items.length - 1, n));
    if (reduceMotion) { state.pos = state.target; layout(); }
  }

  function tick() {
    const diff = state.target - state.pos;
    if (!dragging && Math.abs(diff) > 0.0005) {
      state.pos += diff * 0.11;
      if (Math.abs(state.target - state.pos) < 0.0005) state.pos = state.target;
      layout();
    }
    requestAnimationFrame(tick);
  }

  $("prev").addEventListener("click", () => go(state.target - 1));
  $("next").addEventListener("click", () => go(state.target + 1));
  el.focusOpen.addEventListener("click", () => {
    const p = state.items[Math.round(state.target)];
    if (p) openProject(p.id, el.focusOpen);
  });

  // Wheel: one project per notch-ish, with accumulation for trackpads.
  let wheelAcc = 0, wheelLock = 0;
  el.space.addEventListener("wheel", (e) => {
    if (state.view !== "space") return;
    e.preventDefault();
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    wheelAcc += delta;
    const now = performance.now();
    if (Math.abs(wheelAcc) > 40 && now > wheelLock) {
      go(state.target + Math.sign(wheelAcc));
      wheelAcc = 0;
      wheelLock = now + 180;
    }
  }, { passive: false });

  // Drag to scrub through the projects.
  let dragging = false, dragStartX = 0, dragStartPos = 0, dragMoved = 0, lastX = 0, lastT = 0, velocity = 0;
  el.stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    dragStartX = lastX = e.clientX;
    lastT = performance.now();
    dragStartPos = state.pos;
    dragMoved = 0;
    velocity = 0;
    el.stage.setPointerCapture(e.pointerId);
    el.stage.classList.add("is-dragging");
  });
  el.stage.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - dragStartX;
    dragMoved = Math.max(dragMoved, Math.abs(dx));
    const now = performance.now();
    velocity = (e.clientX - lastX) / Math.max(1, now - lastT);
    lastX = e.clientX; lastT = now;
    const max = state.items.length - 1;
    let p = dragStartPos - dx / (spacing() * 0.9);
    if (p < 0) p *= 0.35;
    if (p > max) p = max + (p - max) * 0.35;
    state.pos = p;
    layout();
  });
  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    el.stage.classList.remove("is-dragging");
    if (dragMoved < 6) {
      const card = e.target.closest && e.target.closest(".card");
      if (card) {
        const i = Number(card.dataset.i);
        if (i === Math.round(state.target)) openProject(state.items[i].id, el.focusOpen);
        else go(i);
      }
      return;
    }
    go(Math.round(state.pos - velocity * 4));
  }
  el.stage.addEventListener("pointerup", endDrag);
  el.stage.addEventListener("pointercancel", endDrag);

  document.addEventListener("keydown", (e) => {
    if (state.openId || $("welcome").open) return;
    if (state.view !== "space") return;
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.key === "ArrowRight") { go(state.target + 1); e.preventDefault(); }
    if (e.key === "ArrowLeft") { go(state.target - 1); e.preventDefault(); }
    if (e.key === "Home") { go(0); e.preventDefault(); }
    if (e.key === "End") { go(state.items.length - 1); e.preventDefault(); }
  });

  window.addEventListener("resize", () => layout(true));

  // ---------- list view ----------
  function renderList() {
    el.list.innerHTML = state.items.map((p) => `
      <li class="row${p.status === "taken" ? " is-taken" : ""}">
        <a href="#/${esc(p.id)}" data-open="${esc(p.id)}">
          <span class="row-plate">${figureHTML(p, false)}</span>
          <span class="row-text">
            <span class="row-level">${esc(levelText(p))}${p.status === "taken" ? ", already taken" : ""}</span>
            <span class="row-title">${esc(p.title)}</span>
            <span class="row-people">${esc(people(p))}${p.collaboration.length ? ` with ${esc(p.collaboration.join(", "))}` : ""}</span>
          </span>
        </a>
      </li>`).join("");
  }
  el.list.addEventListener("click", (e) => {
    const a = e.target.closest("[data-open]");
    if (!a) return;
    e.preventDefault();
    openProject(a.dataset.open, a);
  });

  function setView(view, save) {
    state.view = view;
    el.space.hidden = view !== "space";
    el.listView.hidden = view !== "list";
    el.body.dataset.view = view;
    document.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === view)));
    if (view === "space") layout(true);
    if (save) store.set("mse-view", view);
  }
  document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view, true)));

  // ---------- project detail ----------
  function renderDetail(p) {
    const emails = p.supervisors.map((s) => s.email).filter(Boolean);
    el.detailBody.innerHTML = `
      <header class="d-head">
        <p class="d-level">${esc(levelText(p))}${p.status === "taken" ? `<span class="taken">Already taken</span>` : ""}</p>
        <h2 id="d-title"${p.title.length > 64 ? ` class="long"` : ""}>${esc(p.title)}</h2>
        ${p.subtitle ? `<p class="d-subtitle">${esc(p.subtitle)}</p>` : ""}
      </header>

      <div class="d-grid">
        <div class="d-media">
          ${p.figure ? `
          <figure class="d-figure">
            <button type="button" class="d-plate" id="d-zoom" aria-label="Show the figure larger">${figureHTML(p, true)}</button>
            ${p.caption ? `<figcaption>${esc(p.caption)}</figcaption>` : ""}
          </figure>` : ""}
          ${p.badges.length ? `<div class="d-badges">${p.badges.map((b) => `<img src="${esc(b.src)}" alt="${esc(b.label)}" title="${esc(b.label)}">`).join("")}</div>` : ""}
        </div>

        <div class="d-text">
          ${p.sections.map((s) => `<section>
            <h3>${esc(s.title)}</h3>
            ${s.note ? `<p class="sec-note">${esc(s.note)}</p>` : ""}
            ${blocksHTML(s.blocks)}
          </section>`).join("")}
        </div>

        <aside class="d-side" aria-label="Contact">
          <h3>Supervisors</h3>
          <ul class="d-people">
            ${p.supervisors.map((s) => `<li>
              <span class="d-name">${esc(s.name)}</span>
              ${s.role || s.affiliation ? `<span class="d-role">${esc([s.role, s.affiliation].filter(Boolean).join(", "))}</span>` : ""}
              ${s.email ? `<a href="${esc(mailto([s.email], p))}">${esc(s.email)}</a>` : ""}
            </li>`).join("")}
          </ul>
          ${p.collaboration.length ? `<h3>In collaboration with</h3><ul class="d-collab">${p.collaboration.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
          ${emails.length ? `<a class="cta" href="${esc(mailto(emails, p))}">Email the supervisors</a>
          <p class="cta-hint">Opens your email app with the project title as the subject.</p>` : ""}
        </aside>
      </div>`;

    const zoom = $("d-zoom");
    if (zoom) zoom.addEventListener("click", () => openZoom(p, zoom));
  }

  // Full-screen view of a project figure.
  const zoomBox = document.createElement("div");
  zoomBox.className = "zoom";
  zoomBox.hidden = true;
  zoomBox.setAttribute("role", "dialog");
  zoomBox.setAttribute("aria-modal", "true");
  zoomBox.setAttribute("aria-label", "Figure");
  document.body.appendChild(zoomBox);
  let zoomReturn = null;
  function openZoom(p, from) {
    zoomReturn = from;
    zoomBox.innerHTML = `<button type="button" class="back zoom-close">Close figure</button>
      <div class="zoom-plate">${figureHTML(p, true)}</div>
      ${p.caption ? `<p class="zoom-cap">${esc(p.caption)}</p>` : ""}`;
    zoomBox.hidden = false;
    el.detail.inert = true;
    zoomBox.querySelector(".zoom-close").focus();
  }
  function closeZoom() {
    if (zoomBox.hidden) return false;
    zoomBox.hidden = true;
    el.detail.inert = false;
    if (zoomReturn) zoomReturn.focus();
    return true;
  }
  zoomBox.addEventListener("click", (e) => { if (e.target === zoomBox || e.target.closest(".zoom-close")) closeZoom(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && closeZoom()) e.stopPropagation(); }, true);

  function openProject(id, opener) {
    if (location.hash !== `#/${id}`) {
      state.returnFocus = opener || document.activeElement;
      state.pushedHash = true;
      location.hash = `/${id}`;
    }
  }

  function showDetail(id) {
    const p = ALL.find((x) => x.id === id);
    if (!p) { hideDetail(); return; }
    const wasOpen = !!state.openId;
    state.openId = id;
    renderDetail(p);
    el.detail.hidden = false;
    el.main.inert = true;
    el.header.inert = true;
    el.body.classList.add("detail-open");
    el.detailScroll.scrollTop = 0;
    requestAnimationFrame(() => el.detail.classList.add("is-open"));
    if (!wasOpen) $("d-close").focus({ preventScroll: true });
    document.title = `${p.title} · MSE Project Catalogue`;
    // Keep the gallery in step so closing lands on this project.
    const i = state.items.indexOf(p);
    if (i >= 0) { state.target = state.pos = i; layout(true); }
  }

  function hideDetail() {
    if (!state.openId) return;
    closeZoom();
    state.openId = null;
    el.detail.classList.remove("is-open");
    el.main.inert = false;
    el.header.inert = false;
    el.body.classList.remove("detail-open");
    document.title = "MSE Project Catalogue · DTU Construct";
    const done = () => { if (!state.openId) el.detail.hidden = true; };
    if (reduceMotion) done(); else setTimeout(done, 450);
    const back = state.returnFocus;
    state.returnFocus = null;
    if (back && document.contains(back)) back.focus({ preventScroll: true });
  }

  function closeDetail() {
    if (state.pushedHash) { state.pushedHash = false; history.back(); }
    else { history.replaceState(null, "", location.pathname + location.search); hideDetail(); }
  }

  function stepDetail(dir) {
    const list = state.items.length ? state.items : ALL;
    const i = list.findIndex((p) => p.id === state.openId);
    const next = list[(i + dir + list.length) % list.length];
    if (next) {
      history.replaceState(null, "", `#/${next.id}`);
      showDetail(next.id);
    }
  }

  $("d-close").addEventListener("click", closeDetail);
  $("d-prev").addEventListener("click", () => stepDetail(-1));
  $("d-next").addEventListener("click", () => stepDetail(1));
  el.detail.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeDetail(); return; }
    if (e.key !== "Tab") return;
    const f = [...el.detail.querySelectorAll("a[href], button:not([disabled])")].filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { f[f.length - 1].focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { f[0].focus(); e.preventDefault(); }
  });

  function route() {
    const m = location.hash.match(/^#\/(.+)$/);
    if (m) showDetail(decodeURIComponent(m[1]));
    else { state.pushedHash = false; hideDetail(); }
  }
  window.addEventListener("hashchange", route);

  // ---------- welcome note on group work ----------
  const welcome = $("welcome");
  function openWelcome() {
    if (welcome.open) return;
    if (typeof welcome.showModal === "function") welcome.showModal();
    else welcome.setAttribute("open", "");
  }
  welcome.addEventListener("close", () => store.set("mse-welcome-seen", "1"));
  // Clicking the dimmed area around the note closes it too.
  welcome.addEventListener("click", (e) => { if (e.target === welcome) welcome.close(); });
  $("welcome-open").addEventListener("click", openWelcome);

  // ---------- start ----------
  el.countAll.textContent = pad(ALL.length);
  renderStage();
  renderList();
  const saved = store.get("mse-view");
  setView(saved || (window.innerWidth < 720 ? "list" : "space"), false);
  el.empty.hidden = ALL.length > 0;
  route();
  requestAnimationFrame(tick);
  setTimeout(() => el.body.classList.remove("is-loading"), reduceMotion ? 0 : 900);
  // First visit: show the note once the opening animation has played.
  if (!store.get("mse-welcome-seen")) setTimeout(openWelcome, reduceMotion ? 0 : 1800);
})();
