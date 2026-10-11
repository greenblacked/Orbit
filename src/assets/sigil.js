/* Build sigil: a deterministic glyph drawn from a build string. Same build, same sigil.
   The rule is written out in docs/sigils.md, and tests/test_sigil_doc.py holds the constants
   in SPEC to that page. An Apple build such as 24B5099f follows the Apple rule exactly; any
   other string (an Android, Windows or Ubuntu build) goes through generic(), which hashes
   its characters into the same parameters; that rule is sigil-generic.js, loaded only when
   such a build first appears. The glyph is built with createElementNS, never
   with markup strings. The colour is not part of the rule: the SVG strokes with currentColor. */
(function (global) {
  "use strict";
  var NS = "http://www.w3.org/2000/svg";
  var SPEC = {
    viewBox: 1.05,
    ringMod: 5,
    ringBase: 0.18,
    ringSpan: 0.52,
    ringWidth: 0.014,
    outerWidth: 0.026,
    trains: 26,
    spokes: 11,
    spokeStart: 0.7,
    spokeMin: 0.05,
    spokeSpan: 0.25,
    spokeWidth: 0.02,
    indexWidth: 0.04,
    indexCap: 0.035,
    dotRing: 0.1,
    dotSize: 0.032,
    maxDots: 6,
    minStroke: 1,
    microBelow: 40,
    microRing: 1.5,
    microSpoke: 1,
    microIndex: 2,
    microCap: 1.5,
    microDot: 2,
    microLen: [0.1, 0.2, 0.3],
    microCuts: [2, 6],
    guideWidth: 0.8,
    guideOpacity: 0.22,
    hashMod: 251,
    lcgMul: 75,
    lcgAdd: 74,
    lcgMod: 65537,
    genericDigits: 8
  };
  var APPLE = /^(\d+)([A-Z])(\d+)([a-z]?)$/;
  var generic = null, waiting = [], loading = false, failed = false;

  // sigil-generic.js calls use() with the rule; a glyph that needs it waits (ready).
  function flush(rule, name) {
    generic = rule || generic;
    loading = false;
    waiting.splice(0).forEach(function (w) { if (w[name]) w[name](); });
  }
  function use(fn) { flush(fn, "run"); }
  // One request per host (key); hosts off the page are dropped. fail runs if the rule cannot
  // load, at once in the preview bundle (data-seed) and after one failed load, where nothing queues.
  function ready(run, key, fail) {
    if (generic) return run();
    var doc = global.document;
    if (failed || !doc || doc.querySelector("script[data-seed]")) {
      if (fail) fail();
      return;
    }
    waiting = waiting.filter(function (w) {
      return w.key !== key && !(w.key && !w.key.isConnected);
    });
    waiting.push({ run: run, key: key, fail: fail });
    if (loading) return;
    loading = true;
    var s = doc.createElement("script");
    s.src = "/assets/sigil-generic.js";
    s.onerror = function () {
      failed = true;
      s.remove();
      flush(null, "fail");
    };
    doc.head.appendChild(s);
  }

  // rings, train index t (0..25), the digit list and the suffix dot count of a build.
  function parse(build) {
    var m = APPLE.exec(String(build));
    if (!m) {
      return generic ? generic(build) : { pending: true, rings: 0, dots: 0 };
    }
    return {
      rings: 1 + (Number(m[1]) % SPEC.ringMod),
      t: m[2].charCodeAt(0) - 65,
      digits: m[3].split("").map(Number),
      dots: m[4] ? Math.min(SPEC.maxDots, m[4].charCodeAt(0) - 96) : 0,
      generic: false
    };
  }

  function polar(deg, r) {
    var a = deg * Math.PI / 180;
    return [r * Math.sin(a), -r * Math.cos(a)];
  }

  // Primitives in px about the centre: ["c", r, w] ring, ["l", x0, y0, x1, y1, w] spoke,
  // ["d", x, y, r] dot. R is px per unit; the glyph is 2.1 R wide.
  function prims(build, R, micro) {
    var p = parse(build), out = [], t = p.t, rot = t * 360 / SPEC.trains, k, j, i;
    if (micro === undefined) micro = Math.round(2.1 * R * 1000) / 1000 < SPEC.microBelow;
    var digit = function (n) { return p.digits[(n + t) % p.digits.length]; };
    var spoke = function (n, r0, len, w) {
      var a = rot + n * 360 / SPEC.spokes, s = polar(a, r0), e = polar(a, r0 + len);
      out.push(["l", s[0], s[1], e[0], e[1], w]);
      return e;
    };
    var tip, d, len;
    if (micro) {
      out.push(["c", SPEC.spokeStart * R, SPEC.microRing]);
      for (k = 0; k < SPEC.spokes; k++) {
        d = digit(k);
        len = SPEC.microLen[d <= SPEC.microCuts[0] ? 0 : d <= SPEC.microCuts[1] ? 1 : 2] * R;
        tip = spoke(k, SPEC.spokeStart * R, len, k ? SPEC.microSpoke : SPEC.microIndex);
        if (k === 0) out.push(["d", tip[0], tip[1], SPEC.microCap]);
      }
      if (p.dots) out.push(["d", 0, 0, SPEC.microDot]);
      return out;
    }
    for (j = 1; j <= p.rings; j++) {
      out.push(["c", (SPEC.ringBase + SPEC.ringSpan * j / p.rings) * R,
        Math.max((j === p.rings ? SPEC.outerWidth : SPEC.ringWidth) * R, SPEC.minStroke)]);
    }
    for (k = 0; k < SPEC.spokes; k++) {
      len = (SPEC.spokeMin + SPEC.spokeSpan * digit(k) / 9) * R;
      tip = spoke(k, SPEC.spokeStart * R, len,
        Math.max((k ? SPEC.spokeWidth : SPEC.indexWidth) * R, SPEC.minStroke));
      if (k === 0) out.push(["d", tip[0], tip[1], Math.max(SPEC.indexCap * R, SPEC.minStroke)]);
    }
    for (i = 0; i < p.dots; i++) {
      var q = polar(rot + i * 360 / p.dots, SPEC.dotRing * R);
      out.push(["d", q[0], q[1], Math.max(SPEC.dotSize * R, SPEC.minStroke)]);
    }
    return out;
  }

  // The glyph as an SVG element. opts: doc (default document), color (default currentColor),
  // guide (the optional r = 1 circle), birth (mark the shapes for the draw-in), label.
  function svg(build, size, opts) {
    opts = opts || {};
    var doc = opts.doc || global.document;
    var R = size / 2.1, color = opts.color || "currentColor";
    var f = function (n) { return n.toFixed(3); };
    var make = function (tag, attrs, parent) {
      var el = doc.createElementNS(NS, tag);
      for (var key in attrs) el.setAttribute(key, attrs[key]);
      if (parent) parent.appendChild(el);
      return el;
    };
    var box = f(-SPEC.viewBox * R) + " " + f(-SPEC.viewBox * R) + " " + f(2.1 * R) + " " + f(2.1 * R);
    var root = make("svg", {
      width: size, height: size, viewBox: box, fill: "none", stroke: color,
      "stroke-linecap": "round", "class": "sigil-svg", focusable: "false"
    });
    if (opts.label) {
      root.setAttribute("role", "img");
      root.setAttribute("aria-label", opts.label);
    } else {
      root.setAttribute("aria-hidden", "true");
    }
    if (opts.guide && size >= SPEC.microBelow) {
      make("circle", {
        r: f(R), "stroke-width": SPEC.guideWidth, "stroke-opacity": SPEC.guideOpacity
      }, root);
    }
    var micro = size < SPEC.microBelow, n = 0;
    prims(build, R, micro).forEach(function (p) {
      var el;
      if (p[0] === "c") {
        el = make("circle", { r: f(p[1]), "stroke-width": f(p[2]) }, root);
      } else if (p[0] === "l") {
        el = make("line", {
          x1: f(p[1]), y1: f(p[2]), x2: f(p[3]), y2: f(p[4]), "stroke-width": f(p[5])
        }, root);
      } else {
        el = make("circle", {
          cx: f(p[1]), cy: f(p[2]), r: f(p[3]), fill: color, stroke: "none", "class": "sd"
        }, root);
      }
      if (opts.birth) {
        // The draw-in is CSS: stroke-dashoffset runs from 1 to 0 along a path normalised to
        // length 1, staggered by --i. Dots fade in instead.
        if (p[0] !== "d") el.setAttribute("pathLength", "1");
        el.style.setProperty("--i", String(n++));
      }
    });
    if (opts.birth) root.setAttribute("class", "sigil-svg birth");
    return root;
  }

  // Draw into a host element, replacing what it holds; a glyph that is already there for the
  // same build and size is left alone, so only a new or changed sigil draws itself in.
  function draw(host, build, opts) {
    opts = opts || {};
    var size = opts.size || 64, prev = host.getAttribute("data-build");
    if (!build) {
      host.sigilWant = "";
      host.textContent = "";
      host.removeAttribute("data-build");
      return;
    }
    if (!APPLE.test(build) && !generic) {
      host.textContent = "";
      host.removeAttribute("data-build");
      host.sigilWant = build;
      ready(function () { if (host.sigilWant === build) draw(host, build, opts); }, host,
        function () { if (host.sigilWant === build) host.textContent = build; });
      return;
    }
    host.sigilWant = build;
    if (prev === build && host.getAttribute("data-size") === String(size) && host.firstChild) return;
    host.textContent = "";
    host.appendChild(svg(build, size, {
      doc: host.ownerDocument, birth: opts.birth !== false, guide: opts.guide, label: opts.label
    }));
    host.setAttribute("data-build", build);
    host.setAttribute("data-size", String(size));
  }

  var api = { SPEC: SPEC, parse: parse, prims: prims, svg: svg, draw: draw, use: use, ready: ready };
  if (typeof module !== "undefined" && module.exports) {
    require("./sigil-generic.js")(api);
    module.exports = api;
  } else {
    global.Sigil = api;
  }
})(typeof window !== "undefined" ? window : this);
