/*
 * Pull to Refresh — content script
 *
 * Fires a reload when you overscroll upward at the very top of the page,
 * the way mobile browsers do. Deliberately conservative: a gesture that
 * *began* while the page was scrolled down can never trigger a refresh,
 * which is what kills the classic "trackpad momentum reloaded my page"
 * false positive.
 */
(() => {
  "use strict";

  const api = typeof browser !== "undefined" ? browser : chrome;

  // ---------------------------------------------------------------- settings

  const DEFAULTS = {
    enabled: true,
    threshold: 150,      // px of accumulated overscroll needed to commit
    indicator: "spinner", // "spinner" | "bar" | "none"
    blocklist: []        // hostnames (or *.suffix patterns) to ignore
  };

  let settings = { ...DEFAULTS };
  let active = false; // enabled AND this host isn't blocked

  function hostBlocked(list) {
    const host = location.hostname.toLowerCase();
    return list.some((raw) => {
      const p = String(raw).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      if (!p) return false;
      if (p.startsWith("*.")) {
        const base = p.slice(2);
        return host === base || host.endsWith("." + base);
      }
      return host === p || host.endsWith("." + p);
    });
  }

  function applySettings(next) {
    settings = { ...DEFAULTS, ...next };
    settings.threshold = Math.max(40, Math.min(600, Number(settings.threshold) || DEFAULTS.threshold));
    if (!Array.isArray(settings.blocklist)) settings.blocklist = [];
    active = settings.enabled === true && !hostBlocked(settings.blocklist);
    if (!active) reset(true);
  }

  // ------------------------------------------------------------ scroll state

  const GESTURE_GAP_MS = 160; // silence longer than this starts a new gesture
  const IDLE_RESET_MS = 450;  // stop pulling this long and progress retracts

  let pull = 0;            // accumulated overscroll in px
  let gestureValid = false;
  let lastEventTs = 0;
  let idleTimer = 0;
  let committed = false;

  function isScrollable(el) {
    if (!el || el.nodeType !== 1) return false;
    const s = getComputedStyle(el);
    const oy = s.overflowY;
    if (oy !== "auto" && oy !== "scroll" && oy !== "overlay") return false;
    return el.scrollHeight > el.clientHeight + 1;
  }

  // Walk up from the event target. If any scrollable ancestor is *not* at its
  // own top, this gesture belongs to that container, not to the page.
  function atTopOfChain(startNode) {
    let node = startNode;
    let guard = 0;
    while (node && guard++ < 200) {
      if (node.nodeType === 1 && node !== document.documentElement && node !== document.body) {
        if (isScrollable(node)) {
          if (node.scrollTop > 0) return false;
          // container is at its top — keep walking outward
        }
      }
      node = node.parentNode || (node.host ? node.host : null);
    }
    const doc = document.scrollingElement || document.documentElement;
    return (window.scrollY || doc.scrollTop || 0) <= 0;
  }

  function reset(immediate) {
    pull = 0;
    gestureValid = false;
    clearTimeout(idleTimer);
    idleTimer = 0;
    ui.retract(immediate === true);
  }

  function commit() {
    if (committed) return;
    committed = true;
    gestureValid = false;
    clearTimeout(idleTimer);
    ui.commit(() => location.reload());
  }

  function advance(px) {
    pull += px;
    if (pull < 0) pull = 0;
    ui.progress(Math.min(1, pull / settings.threshold));
    if (pull >= settings.threshold) commit();
  }

  function armIdleReset() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => reset(false), IDLE_RESET_MS);
  }

  // ------------------------------------------------------------------- wheel

  function normalizeDelta(e) {
    if (e.deltaMode === 1) return e.deltaY * 16;        // lines
    if (e.deltaMode === 2) return e.deltaY * window.innerHeight; // pages
    return e.deltaY;                                     // pixels
  }

  window.addEventListener(
    "wheel",
    (e) => {
      if (!active || committed) return;

      const now = e.timeStamp || performance.now();
      const gap = now - lastEventTs;
      lastEventTs = now;

      const dy = normalizeDelta(e);

      if (gap > GESTURE_GAP_MS) {
        // New gesture. It only counts if the page is *already* pinned at the
        // top when the user starts scrolling up. Momentum tails from a fling
        // are continuous, so they never open a new gesture here.
        pull = 0;
        gestureValid = dy < 0 && atTopOfChain(e.target);
        if (!gestureValid) {
          ui.retract(false);
          return;
        }
      }

      if (!gestureValid) return;

      if (dy > 0) {
        // user reversed direction mid-gesture — abandon
        reset(false);
        gestureValid = false;
        return;
      }

      advance(-dy);
      armIdleReset();
    },
    { passive: true, capture: true }
  );

  // Any actual downward scroll invalidates whatever was in flight.
  window.addEventListener(
    "scroll",
    () => {
      const doc = document.scrollingElement || document.documentElement;
      if ((window.scrollY || doc.scrollTop || 0) > 0 && pull > 0) reset(false);
    },
    { passive: true }
  );

  // ------------------------------------------------------------------- touch

  let touchStartY = 0;
  let touchValid = false;

  window.addEventListener(
    "touchstart",
    (e) => {
      if (!active || committed || e.touches.length !== 1) {
        touchValid = false;
        return;
      }
      touchStartY = e.touches[0].clientY;
      touchValid = atTopOfChain(e.target);
      pull = 0;
    },
    { passive: true, capture: true }
  );

  window.addEventListener(
    "touchmove",
    (e) => {
      if (!touchValid || !active || committed || e.touches.length !== 1) return;
      const dy = e.touches[0].clientY - touchStartY; // finger down = positive
      if (dy <= 0) {
        pull = 0;
        ui.progress(0);
        return;
      }
      pull = dy * 0.7; // rubber-band feel
      ui.progress(Math.min(1, pull / settings.threshold));
    },
    { passive: true, capture: true }
  );

  window.addEventListener(
    "touchend",
    () => {
      if (!touchValid) return;
      touchValid = false;
      if (pull >= settings.threshold) commit();
      else reset(false);
    },
    { passive: true, capture: true }
  );

  // Bail out of any in-flight pull if the tab is hidden or loses focus.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) reset(true);
  });
  window.addEventListener("blur", () => reset(true), true);

  // ---------------------------------------------------------------------- UI

  const ui = (() => {
    let host = null;
    let root = null;
    let puck = null;
    let arc = null;
    let bar = null;
    let mounted = false;

    const CIRC = 2 * Math.PI * 11; // r = 11

    function mount() {
      if (mounted || settings.indicator === "none") return;
      if (!document.documentElement) return;

      host = document.createElement("div");
      host.setAttribute("data-pull-to-refresh", "");
      host.style.cssText =
        "all:initial;position:fixed;top:0;left:0;width:100%;height:0;" +
        "z-index:2147483647;pointer-events:none;";
      root = host.attachShadow({ mode: "closed" });

      // Built node by node with the DOM API. Nothing here is dynamic, but the
      // add-on linter flags raw HTML string assignment on sight, so avoid it.
      const style = document.createElement("style");
      style.textContent = `
          :host { all: initial; }
          .wrap {
            position: fixed;
            top: 0; left: 0; right: 0;
            display: flex;
            justify-content: center;
            pointer-events: none;
          }
          .puck {
            margin-top: 12px;
            width: 30px; height: 30px;
            border-radius: 50%;
            background: #ffffff;
            box-shadow: 0 2px 8px rgba(0,0,0,.18), 0 0 0 .5px rgba(0,0,0,.06);
            display: flex; align-items: center; justify-content: center;
            transform: translateY(-46px) scale(.7);
            opacity: 0;
            will-change: transform, opacity;
          }
          .puck.smooth { transition: transform .28s cubic-bezier(.22,1,.36,1), opacity .2s ease; }
          .puck.spinning { animation: orbit .7s linear infinite; }
          svg { display: block; }
          .track { stroke: rgba(0,0,0,.10); }
          .arc {
            stroke: #3b7ddd;
            stroke-linecap: round;
            transform: rotate(-90deg);
            transform-origin: 50% 50%;
            stroke-dasharray: ${CIRC};
            stroke-dashoffset: ${CIRC};
          }
          .puck.spinning .arc { stroke-dasharray: ${CIRC * 0.28} ${CIRC}; }
          .bar {
            position: fixed;
            top: 0; left: 0;
            height: 3px;
            width: 0%;
            background: #3b7ddd;
            opacity: 0;
          }
          .bar.smooth { transition: width .25s ease, opacity .2s ease; }
          .bar.spinning { animation: sweep .9s ease-in-out infinite; }
          @keyframes orbit { to { transform: translateY(0) scale(1) rotate(360deg); } }
          @keyframes sweep {
            0%   { margin-left: 0%;  width: 20%; }
            50%  { margin-left: 40%; width: 60%; }
            100% { margin-left: 100%; width: 10%; }
          }
          @media (prefers-color-scheme: dark) {
            .puck { background: #2b2b2f; box-shadow: 0 2px 10px rgba(0,0,0,.5); }
            .track { stroke: rgba(255,255,255,.14); }
            .arc { stroke: #7aa9f7; }
            .bar { background: #7aa9f7; }
          }
          @media (prefers-reduced-motion: reduce) {
            .puck.spinning { animation-duration: 1.4s; }
          }
      `;

      const SVG_NS = "http://www.w3.org/2000/svg";
      const circle = (cls) => {
        const c = document.createElementNS(SVG_NS, "circle");
        c.setAttribute("class", cls);
        c.setAttribute("cx", "13");
        c.setAttribute("cy", "13");
        c.setAttribute("r", "11");
        c.setAttribute("fill", "none");
        c.setAttribute("stroke-width", "2.5");
        return c;
      };

      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("width", "26");
      svg.setAttribute("height", "26");
      svg.setAttribute("viewBox", "0 0 26 26");
      const track = circle("track");
      arc = circle("arc");
      svg.append(track, arc);

      puck = document.createElement("div");
      puck.className = "puck smooth";
      puck.appendChild(svg);

      const wrap = document.createElement("div");
      wrap.className = "wrap";
      wrap.appendChild(puck);

      bar = document.createElement("div");
      bar.className = "bar smooth";

      root.append(style, wrap, bar);
      document.documentElement.appendChild(host);
      mounted = true;
    }

    function ensure() {
      if (settings.indicator === "none") return false;
      if (!mounted) mount();
      return mounted;
    }

    return {
      progress(p) {
        if (!ensure()) return;
        if (settings.indicator === "bar") {
          puck.style.opacity = "0";
          bar.classList.remove("smooth");
          bar.style.opacity = p > 0 ? "1" : "0";
          bar.style.width = (p * 100).toFixed(1) + "%";
          return;
        }
        bar.style.opacity = "0";
        puck.classList.remove("smooth");
        // Ease the travel so the puck is legible early in the pull while the
        // arc keeps filling all the way to the threshold.
        const drop = 1 - (1 - Math.min(1, p)) * (1 - Math.min(1, p));
        puck.style.opacity = String(Math.min(1, p * 2.2));
        puck.style.transform =
          "translateY(" + (-46 + drop * 46).toFixed(1) + "px) scale(" +
          (0.7 + drop * 0.3).toFixed(3) + ") rotate(" + (p * 300).toFixed(1) + "deg)";
        arc.style.strokeDashoffset = String(CIRC * (1 - Math.min(1, p)));
      },

      retract(immediate) {
        if (!mounted) return;
        if (immediate) {
          puck.classList.remove("smooth", "spinning");
          bar.classList.remove("smooth", "spinning");
        } else {
          puck.classList.add("smooth");
          bar.classList.add("smooth");
        }
        puck.style.opacity = "0";
        puck.style.transform = "translateY(-46px) scale(.7)";
        arc.style.strokeDashoffset = String(CIRC);
        bar.style.opacity = "0";
        bar.style.width = "0%";
      },

      commit(done) {
        if (!ensure()) {
          done();
          return;
        }
        if (settings.indicator === "bar") {
          bar.classList.remove("smooth");
          bar.style.opacity = "1";
          bar.classList.add("spinning");
        } else {
          puck.classList.remove("smooth");
          puck.style.opacity = "1";
          puck.style.transform = "translateY(0) scale(1)";
          arc.style.strokeDashoffset = "0";
          puck.classList.add("spinning");
        }
        setTimeout(done, 180);
      }
    };
  })();

  // --------------------------------------------------------- load user prefs
  // (last, so `ui` is initialised before applySettings can touch it)

  try {
    const store = api.storage.sync || api.storage.local;
    const got = store.get(DEFAULTS);
    if (got && typeof got.then === "function") {
      got.then(applySettings, () => api.storage.local.get(DEFAULTS).then(applySettings, () => {}));
    } else {
      store.get(DEFAULTS, applySettings);
    }
    api.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync" && area !== "local") return;
      const next = { ...settings };
      for (const k of Object.keys(changes)) next[k] = changes[k].newValue;
      applySettings(next);
    });
  } catch (_) {
    applySettings(DEFAULTS); // storage unavailable — run on defaults
  }
})();
