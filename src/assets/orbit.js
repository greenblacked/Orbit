/* Release Orbit dial: one ring per platform family (the first family outermost), one notch per
   release placed by date over a trailing window, drawn as SVG from the same data as the rest of
   the page. A release is a long, broad notch; a beta or release candidate a shorter, thinner one,
   in the same full accent colour. Each notch carries a small marker for its validation status
   (pass, warn, fail; untested until a verdict exists). A notch is a button: hover, focus or a tap
   opens a card with the build's sigil, version, build, date and a link. The dial is a stack of
   SVG layers (base, one per ring, hand) so the rings can separate in 3D (see "Signature" in
   site.css). The hand is a slider and the time machine: drag it (pointer or touch) or use the
   arrow keys, Page Up and Page Down, Home and End, and the page below shows the releases that
   had landed by that day; "Back to now" is the only way back, so nothing springs on its own.
   Text goes in with textContent and attributes only. */
(function () {
  "use strict";
  var RO = window.RO;
  var stage = document.getElementById("orbit-stage");
  if (!RO || !stage) return;
  var NS = "http://www.w3.org/2000/svg";
  var DAY = 86400000;
  var HALF = 330;                                  // the viewBox runs from -HALF to HALF
  var OUTER = 268, STEP = 30, INNER = 120;         // outermost ring, gap between rings, the innermost ring's floor (the hub's date needs the rest)
  var LEN = { release: 22, rc: 15, beta: 12 };     // notch length
  var WID = { release: 4.5, rc: 3, beta: 2.4 };    // notch width
  var MIN_LEN = 8, MIN_WID = 1.5;                  // floors for a crowded dial
  var FAN = 12;                                    // spacing of notches stamped at one moment
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var VERDICT = {
    pass: "passed", warn: "passed with warnings", fail: "failed", untested: "untested"
  };
  var dial = document.getElementById("orbit-dial");
  var card = document.getElementById("orbit-card");
  var all = [];                                    // every release, newest first
  var weeks = 26, now = 0, start = 0, span = 0;
  var notches = [], signature = "", pinned = "", hideTimer = 0;
  var ui = {};
  var centres = null;                              // notch centres in stage space, read once per layout

  function el(tag, attrs, parent) {
    var node = document.createElementNS(NS, tag);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(node);
    return node;
  }
  function r2(v) { return Math.round(v * 100) / 100; }
  function xy(deg, r) {
    var a = deg * Math.PI / 180;
    return [r2(r * Math.sin(a)), r2(-r * Math.cos(a))];
  }
  // Degrees clockwise from 12 o'clock: the start of the window and now are both at the top.
  function angle(t) { return 360 * (t - start) / span; }
  function famClass(id) { return "fam-" + String(id).toLowerCase(); }
  function nextMonth(t) {
    var d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  function layer(cls) {
    return el("svg", {
      viewBox: -HALF + " " + -HALF + " " + 2 * HALF + " " + 2 * HALF,
      "class": "layer " + cls, focusable: "false"
    }, dial);
  }
  // The knob's grab area is at least 44 CSS px across at any stage width: its radius in
  // viewBox units is 22 CSS px times the units per pixel.
  function sizeKnob() {
    var w = stage.clientWidth;
    // Units per CSS pixel: the dial's text is sized in it (see .mlabel in site.css) so it keeps
    // a readable size when the stage shrinks on a phone.
    if (w > 0) stage.style.setProperty("--upx", String(r2(2 * HALF / w)));
    centres = null;
    if (!ui.knob) return;
    ui.knob.setAttribute("r", String(r2(w > 0 ? Math.max(22, 22 * 2 * HALF / w) : 22)));
  }
  function label(r) {
    return r.title.replace(/ \(.*\)$/, "") + (r.build ? ", build " + r.build : "") + ", " +
      RO.day(r.t) + ", validation " + VERDICT[r.status];
  }

  // The marker beside a notch's outer end: a hollow circle (untested), a filled circle (pass),
  // a diamond (warn) or a cross (fail), so the verdict never rests on colour alone.
  function marker(g, c, status, s) {
    var x = c[0], y = c[1], m, d = r2(4.5 * s), e = r2(3.5 * s);
    if (status === "warn") {
      m = el("path", { d: "M" + x + " " + r2(y - d) + "L" + r2(x + d) + " " + y + "L" + x + " " + r2(y + d) + "L" + r2(x - d) + " " + y + "Z" }, g);
    } else if (status === "fail") {
      m = el("path", { d: "M" + r2(x - e) + " " + r2(y - e) + "L" + r2(x + e) + " " + r2(y + e) + "M" + r2(x + e) + " " + r2(y - e) + "L" + r2(x - e) + " " + r2(y + e) }, g);
    } else {
      m = el("circle", { cx: x, cy: y, r: r2(3.4 * s) }, g);
    }
    m.setAttribute("class", "mk mk-" + status);
  }

  function families() {
    var list = RO.families();
    if (list.length) return list;
    var seen = {};
    return all.filter(function (r) { return !seen[r.family] && (seen[r.family] = true); })
      .map(function (r) { return { id: r.family, name: r.family }; });
  }

  function build() {
    now = Date.now();
    var oldest = all.length ? all[all.length - 1].t : now;
    weeks = now - oldest > 26 * 7 * DAY ? 52 : 26;
    span = weeks * 7 * DAY;
    start = now - span;
    dial.textContent = "";
    notches = [];
    var fams = families();
    dial.setAttribute("aria-label", "Release dial: the releases of the last " + weeks + " weeks, one ring per platform");
    dial.setAttribute("data-weeks", String(weeks));

    var base = layer("base");
    base.setAttribute("aria-hidden", "true");
    for (var m = nextMonth(start - 1); m <= now; m = nextMonth(m)) {
      var a = angle(m), p0 = xy(a, OUTER + 16), p1 = xy(a, OUTER + 28), q = xy(a, OUTER + 38);
      el("line", { "class": "tick", x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1] }, base);
      var t = el("text", { "class": "mlabel", x: q[0], y: q[1] }, base);
      t.textContent = MONTHS[new Date(m).getUTCMonth()];
    }
    ui.date = el("text", { "class": "c-date", y: -4 }, base);
    ui.note = el("text", { "class": "c-note", y: 28 }, base);
    el("text", { "class": "c-note", y: 52 }, base).textContent = weeks + " weeks";

    var counts = {};
    // Rings are STEP apart while they fit between OUTER and INNER; with more families they
    // close up, and the notches, their markers and their grab areas shrink with the gap so
    // that adjacent rings never overlap.
    var nf = fams.length;
    var step = nf > 1 ? Math.min(STEP, (OUTER - INNER) / (nf - 1)) : STEP;
    var scale = step / STEP, ms = Math.min(1, Math.max(0.55, scale));
    fams.forEach(function (fam, i) {
      var lane = layer("lane " + famClass(fam.id));
      lane.style.setProperty("--lane", String(i));
      lane.setAttribute("data-family", fam.id);
      var rad = OUTER - i * step;
      el("circle", { "class": "ring", r: rad, "data-family": fam.id }, lane);
      counts[fam.id] = 0;
      // Releases of one family stamped at the same moment would sit on one spot and only the
      // top one could be opened. They fan out sideways around that spot, FAN units apart on
      // the ring (a few days at most), each with a narrower grab area, so each has its own.
      var mine = all.filter(function (r) { return r.family === fam.id && r.t >= start && r.t <= now; });
      var stack = {}, seat = {};
      mine.forEach(function (r) { stack[r.t] = (stack[r.t] || 0) + 1; });
      mine.forEach(function (r) {
        counts[fam.id]++;
        var n = stack[r.t], k = seat[r.t] || 0;
        seat[r.t] = k + 1;
        // Never below a floor, so a notch stays visible and tappable on a crowded dial.
        var len = Math.max(LEN[r.stage] * scale, MIN_LEN), wid = Math.max(WID[r.stage] * scale, MIN_WID);
        var reach = Math.min(len / 2 + 8, step / 2 - 1);
        var ang = angle(r.t) + (n > 1 ? (k - (n - 1) / 2) * FAN * 180 / (Math.PI * rad) : 0);
        var a0 = xy(ang, rad - len / 2), a1 = xy(ang, rad + len / 2);
        var h0 = xy(ang, rad - reach), h1 = xy(ang, rad + reach);
        var g = el("g", {
          "class": "notch " + r.stage, role: "button", tabindex: "-1", "data-id": r.id,
          "data-status": r.status, "aria-label": label(r)
        }, lane);
        el("line", { "class": "hit", x1: h0[0], y1: h0[1], x2: h1[0], y2: h1[1], "stroke-width": n > 1 ? FAN - 2 : 26 }, g);
        el("line", { "class": "nl", x1: a0[0], y1: a0[1], x2: a1[0], y2: a1[1], "stroke-width": r2(wid) }, g);
        // Just past the notch's outer end, sized to fit the free space before the next ring's
        // notch (a diamond is 9 units across plus its stroke) down to the 0.55 floor.
        var mk = Math.min(ms, Math.max(0.55, (step - len - 1.5) / 10.4));
        marker(g, xy(ang, rad + len / 2 + 0.75 + 4.7 * mk), r.status, mk);
        notches.push(g);
        g.rel = r;
      });
    });
    centres = null;
    notches.sort(function (x, y) { return x.rel.t - y.rel.t; });
    if (notches.length) notches[notches.length - 1].setAttribute("tabindex", "0");

    var top = layer("hand-layer");
    // The hand is the dial's slider: it sets the date the page shows (the time machine).
    ui.hand = el("g", {
      "class": "hand", transform: "rotate(360)", role: "slider", tabindex: "0",
      "aria-label": "Time machine hand", "aria-valuemin": 0, "aria-valuemax": weeks * 7,
      "aria-valuenow": weeks * 7, "aria-describedby": "orbit-help"
    }, top);
    // Only the knob outside the rings takes the pointer: a line hit area over the rings would
    // sit on top of every notch the hand points at. Its radius is sized in CSS pixels.
    ui.knob = el("circle", { "class": "hit", cx: 0, cy: -(OUTER + 24), r: 22 }, ui.hand);
    ui.hand.addEventListener("touchstart", function (e) { e.preventDefault(); }, { passive: false });
    sizeKnob();
    el("line", { "class": "hl", x1: 0, y1: -110, x2: 0, y2: -(OUTER + 20) }, ui.hand);
    el("circle", { "class": "hk", cx: 0, cy: -(OUTER + 24), r: 6 }, ui.hand);
    el("circle", { "class": "hk", cx: 0, cy: -110, r: 4 }, ui.hand);

    // The window start moved on: the hand cannot stay before it. Say so, so the cards, the
    // sections and the cadence row below show the same day as the dial.
    var before = asOf;
    if (asOf !== null) asOf = Math.max(asOf, snap(start));
    paintKey(fams, counts);
    paintView();
    if (asOf !== before) {
      announce();
      document.dispatchEvent(new CustomEvent("ro:asof", { detail: { t: asOf } }));
    }
    document.dispatchEvent(new CustomEvent("ro:orbit"));
  }

  // The time machine. asOf is null for now, else the end of a UTC day the hand points at; the
  // page below the dial listens for "ro:asof" and shows the releases that had landed by then.
  var asOf = null, announceTimer = 0;
  function snap(t) { return Math.floor(t / DAY) * DAY + DAY - 1; }
  function paintView() {
    var t = asOf === null ? now : asOf;
    ui.hand.setAttribute("transform", "rotate(" + r2(angle(t)) + ")");
    ui.hand.setAttribute("aria-valuenow", String(Math.round((t - start) / DAY)));
    ui.hand.setAttribute("aria-valuetext", asOf === null ? "Now, " + RO.day(now) : "As of " + RO.day(asOf));
    ui.date.textContent = RO.day(t);
    ui.note.textContent = asOf === null ? "NOW" : "TIME MACHINE";
    var landed = 0;
    notches.forEach(function (g) {
      var later = asOf !== null && g.rel.t > asOf;
      g.classList.toggle("later", later);
      if (!later) landed++;
    });
    var out = document.getElementById("orbit-asof");
    var plural = function (n) { return n + (n === 1 ? " release" : " releases"); };
    out.textContent = asOf === null
      ? "Today, " + RO.day(now) + ": " + plural(notches.length) + " in the last " + weeks + " weeks."
      : "As of " + RO.day(asOf) + ": " + landed + " of " + plural(notches.length) +
        " in the window had landed. The cards and sections below show that day.";
    var w = document.getElementById("orbit-weeks");
    if (w) w.textContent = String(weeks);
    var back = document.getElementById("orbit-back");
    if (back) back.hidden = asOf === null;
  }
  function announce() {
    window.clearTimeout(announceTimer);
    announceTimer = window.setTimeout(function () {
      var live = document.getElementById("orbit-live");
      if (!live) return;
      if (asOf === null) { live.textContent = "Showing the latest releases."; return; }
      var have = families().filter(function (f) {
        return all.some(function (r) { return r.family === f.id && r.t <= asOf; });
      }).length;
      live.textContent = "Showing releases as of " + RO.day(asOf) + ". " + have + " of " +
        families().length + " platforms have a release.";
    }, 200);
  }
  // Move the hand to a time; a time at or after now means now.
  function setAsOf(t) {
    var next = t === null || snap(t) >= now ? null : Math.max(snap(t), snap(start));
    if (next === asOf) return;
    asOf = next;
    paintView();
    announce();
    document.dispatchEvent(new CustomEvent("ro:asof", { detail: { t: asOf, dragging: !!drag } }));
  }
  // A drag moves the hand once per frame at most: the page below listens to every change.
  var pending = null, frame = 0;
  function flush() {
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    if (pending === null) return;
    var t = pending;
    pending = null;
    setAsOf(t);
  }
  function stepHand(e) {
    var t = asOf === null ? now : asOf, to = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") to = t + DAY;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") to = t - DAY;
    else if (e.key === "PageUp") to = t + 7 * DAY;
    else if (e.key === "PageDown") to = t - 7 * DAY;
    else if (e.key === "End") to = now;
    else if (e.key === "Home") to = start;
    else return;
    e.preventDefault();
    setAsOf(to);
  }
  var drag = null, moved = false, pressed = false;
  function pointerFraction(e) {
    var r = stage.getBoundingClientRect();
    var deg = Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))) * 180 / Math.PI;
    return (deg < 0 ? deg + 360 : deg) / 360;
  }

  function paintKey(fams, counts) {
    var key = document.getElementById("orbit-key");
    if (!key) return;
    key.textContent = "";
    fams.forEach(function (fam) {
      var li = RO.h("li", famClass(fam.id));
      li.appendChild(RO.h("span", "sw", null, { "aria-hidden": "true" }));
      li.appendChild(RO.h("span", "k-name", fam.name || fam.id));
      li.appendChild(RO.h("span", "k-n", String(counts[fam.id] || 0)));
      key.appendChild(li);
    });
  }

  // The card: the build's sigil, version, build, date and a link.
  function fill(r) {
    card.textContent = "";
    card.className = "orbit-card " + famClass(r.family);
    card.setAttribute("data-id", r.id);
    var sig = RO.h("span", "sigil");
    card.appendChild(sig);
    if (window.Sigil) window.Sigil.draw(sig, RO.sigilKey(r), { size: 64, onfail: function (el) { el.hidden = true; } });
    else sig.hidden = true;
    var text = RO.h("div", "oc-text");
    text.appendChild(RO.h("p", "oc-title", r.family + " " + RO.short(r)));
    text.appendChild(RO.h("p", "oc-build", r.build ? "Build " + r.build : RO.channel(r)));
    text.appendChild(RO.h("p", "oc-date small", RO.day(r.t) + " · " + VERDICT[r.status]));
    var link = RO.h("a", "rel-apple", "View release", { href: r.url, target: "_blank", rel: "noopener noreferrer" });
    link.appendChild(RO.h("span", "sr-only", " (opens in a new tab)"));
    text.appendChild(link);
    card.appendChild(text);
  }
  function place(g) {
    var hr = stage.getBoundingClientRect(), nr = g.getBoundingClientRect();
    var cx = nr.left + nr.width / 2 - hr.left, cy = nr.top + nr.height / 2 - hr.top;
    var w = card.offsetWidth, h = card.offsetHeight;
    var left = Math.max(0, Math.min(hr.width - w, cx - w / 2));
    var top = cy + 22;
    if (top + h > hr.height) top = Math.max(0, cy - h - 22);
    card.style.setProperty("--cx", Math.round(left) + "px");
    card.style.setProperty("--cy", Math.round(top) + "px");
  }
  function show(g, pin) {
    window.clearTimeout(hideTimer);
    var r = g.rel;
    if (!r || (pinned && !pin && pinned !== r.id)) return;
    if (card.getAttribute("data-id") !== r.id) fill(r);
    card.hidden = false;
    place(g);
    if (pin) pinned = r.id;
  }
  function hide(force) {
    window.clearTimeout(hideTimer);
    if (pinned && !force) return;
    // Focus inside the card would fall to the page start when the card goes: give it back to
    // the notch the card belongs to, or to the roving one.
    if (force && !card.hidden && card.contains(document.activeElement)) {
      var id = card.getAttribute("data-id");
      var home = notches.filter(function (n) { return n.rel.id === id; })[0] ||
        notches.filter(function (n) { return n.getAttribute("tabindex") === "0"; })[0];
      if (home) rove(home);
    }
    pinned = "";
    card.hidden = true;
    card.removeAttribute("data-id");
  }
  function later() {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(function () { hide(false); }, 220);
  }
  function notchOf(target) {
    return target && target.closest ? target.closest(".notch") : null;
  }
  function inHand(target) {
    return !!(target && target.closest && target.closest(".hand"));
  }
  // Tapping or hovering the knob opens the notch beneath it, if there is one: the knob is bigger
  // than a notch, and the notches the hand points at are the ones worth opening.
  function toggleNearest(e) {
    var g = nearest(e.clientX, e.clientY, 22);
    if (!g) return;
    if (pinned === g.rel.id) hide(true);
    else show(g, true);
  }
  // The notch nearest to a point, within a tap's reach: the dial is small on a phone.
  function nearest(x, y, reach) {
    var best = null, bestD = reach;
    var sr = stage.getBoundingClientRect();
    // The centres are read once and kept until the layout changes (build, resize, scroll), so
    // a pointer move costs one rect, not one per notch.
    if (!centres) {
      centres = notches.map(function (g) {
        var r = g.getBoundingClientRect();
        return [r.left + r.width / 2 - sr.left, r.top + r.height / 2 - sr.top];
      });
    }
    notches.forEach(function (g, i) {
      var d = Math.hypot(centres[i][0] + sr.left - x, centres[i][1] + sr.top - y);
      if (d < bestD) { best = g; bestD = d; }
    });
    return best;
  }
  function rove(g) {
    notches.forEach(function (n) { n.setAttribute("tabindex", n === g ? "0" : "-1"); });
    g.focus();
  }

  stage.addEventListener("pointerover", function (e) {
    var g = notchOf(e.target);
    if (g) { show(g, false); return; }
    if (!card.contains(e.target)) return;
    // A card still closing can sit over another notch. A pointer that arrives on it from outside
    // the stage at that notch's centre opens that notch; one that comes from the card's own notch
    // (through the stage) keeps the card where it is.
    var from = e.relatedTarget;
    if (e.pointerType !== "touch" && !pinned && !(from && stage.contains(from))) {
      var covered = nearest(e.clientX, e.clientY, 6);
      if (covered && covered.rel.id !== card.getAttribute("data-id")) { show(covered, false); return; }
    }
    window.clearTimeout(hideTimer);
  });
  stage.addEventListener("pointerout", function (e) {
    if (notchOf(e.target) || card.contains(e.target) || inHand(e.target)) later();
  });
  stage.addEventListener("focusin", function (e) {
    var g = notchOf(e.target);
    if (g) show(g, false);
  });
  stage.addEventListener("focusout", function (e) {
    var to = e.relatedTarget;
    if (to && (card.contains(to) || notchOf(to))) return;
    later();
  });
  stage.addEventListener("click", function (e) {
    // A press that began on the hand is settled on pointer up (see drop).
    if (moved || pressed || card.contains(e.target) || inHand(e.target)) return;
    var g = notchOf(e.target) || nearest(e.clientX, e.clientY, 22);
    if (!g) { hide(true); return; }
    if (pinned === g.rel.id) hide(true);
    else show(g, true);
  });
  // Dragging the hand, with a mouse, a pen or a finger. The hand follows the pointer's angle by
  // its change since the press, so it never jumps, and it cannot be taken past now or the start.
  stage.addEventListener("pointerdown", function (e) {
    if (!inHand(e.target) || (e.button !== undefined && e.button > 0)) return;
    var t = asOf === null ? now : asOf;
    drag = { id: e.pointerId, frac: (t - start) / span, last: pointerFraction(e) };
    moved = false;
    pressed = true;
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* the drag still works inside the dial */ }
    ui.hand.focus();
    e.preventDefault();
  });
  stage.addEventListener("pointermove", function (e) {
    if (!drag) {
      // Hovering the knob shows the card of a notch under it, as hovering the notch would.
      if (e.pointerType !== "touch" && inHand(e.target)) {
        var under = nearest(e.clientX, e.clientY, 22);
        if (under) show(under, false);
      }
      return;
    }
    if (e.pointerId !== drag.id) return;
    var f = pointerFraction(e), d = f - drag.last;
    if (d > 0.5) d -= 1;
    else if (d < -0.5) d += 1;
    drag.frac = Math.min(1, Math.max(0, drag.frac + d));
    drag.last = f;
    moved = true;
    pending = start + drag.frac * span;
    if (!frame) frame = window.requestAnimationFrame(flush);
  });
  function drop(e) {
    if (!drag || e.pointerId !== drag.id) return;
    var still = !moved && e.type === "pointerup";
    flush();
    drag = null;
    // One last event, once the drag is over, so the page below settles on the final day.
    if (moved) document.dispatchEvent(new CustomEvent("ro:asof", { detail: { t: asOf, dragging: false } }));
    // The click that follows a drag must not open a card.
    window.setTimeout(function () { moved = false; pressed = false; }, 60);
    if (still) toggleNearest(e);
  }
  stage.addEventListener("pointerup", drop);
  stage.addEventListener("pointercancel", drop);
  // A finger that starts on the hand moves the hand, not the page: that listener is on the hand
  // itself (see build), so a touch anywhere else on the dial scrolls without waiting for script.
  window.addEventListener("resize", sizeKnob, { passive: true });
  // Capture, so a scrolling ancestor counts too. The tilt and the lane lift also move the
  // notches without a scroll or resize, so the centres are dropped when those end, and when the
  // stage changes size for any other reason.
  function forget() { centres = null; }
  window.addEventListener("scroll", forget, { passive: true, capture: true });
  stage.addEventListener("transitionend", forget);
  stage.addEventListener("animationend", forget);
  if (window.ResizeObserver) new ResizeObserver(sizeKnob).observe(stage);
  var back = document.getElementById("orbit-back");
  if (back) {
    back.addEventListener("click", function () {
      setAsOf(null);
      if (ui.hand) ui.hand.focus();
    });
  }
  stage.addEventListener("keydown", function (e) {
    if (inHand(e.target)) { stepHand(e); return; }
    var g = notchOf(e.target);
    if (!g) return;
    var i = notches.indexOf(g), to = -1;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (pinned === g.rel.id) hide(true);
      else show(g, true);
      return;
    }
    if (e.key === "ArrowRight" || e.key === "ArrowDown") to = Math.min(notches.length - 1, i + 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") to = Math.max(0, i - 1);
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = notches.length - 1;
    if (to < 0) return;
    e.preventDefault();
    rove(notches[to]);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !card.hidden) hide(true);
  });
  document.addEventListener("pointerdown", function (e) {
    if (!card.hidden && !stage.contains(e.target)) hide(true);
  });

  RO.on(function (data, fresh, failed) {
    if (!data) {
      var asofText = document.getElementById("orbit-asof"), helpText = document.getElementById("orbit-help");
      if (failed) {
        if (asofText) asofText.textContent = "The dial could not load. The source is linked below.";
        if (helpText) helpText.hidden = true;
      }
      return;
    }
    var helpNow = document.getElementById("orbit-help");
    if (helpNow) helpNow.hidden = false;
    var next = data.releases.map(function (r) { return r.id + r.status; }).join("|") + "|" +
      Math.floor(Date.now() / (6 * 3600000));
    if (next === signature || stage.contains(document.activeElement)) return;
    signature = next;
    all = data.releases;
    hide(true);
    build();
  });
})();
