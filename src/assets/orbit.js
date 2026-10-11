/* Release Orbit dial: one ring per platform family (the first family outermost), one notch per
   release placed by date over a trailing window, drawn as SVG from the same data as the rest of
   the page. A release is a long, broad notch; a beta or release candidate a shorter, thinner one,
   in the same full accent colour. Each notch carries a small marker for its validation status
   (pass, warn, fail; untested until a verdict exists). A notch is a button: hover, focus or a tap
   opens a card with the build's sigil, version, build, date and a link. The dial is a stack of
   SVG layers (base, one per ring, hand) so the rings can separate in 3D (see "Signature" in
   site.css). Text goes in with textContent and attributes only. */
(function () {
  "use strict";
  var RO = window.RO;
  var stage = document.getElementById("orbit-stage");
  if (!RO || !stage) return;
  var NS = "http://www.w3.org/2000/svg";
  var DAY = 86400000;
  var HALF = 330;                                  // the viewBox runs from -HALF to HALF
  var OUTER = 268, STEP = 30;                      // outermost ring radius, gap between rings
  var LEN = { release: 22, rc: 15, beta: 12 };     // notch length
  var WID = { release: 4.5, rc: 3, beta: 2.4 };    // notch width
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
  function label(r) {
    return r.title.replace(/ \(.*\)$/, "") + (r.build ? ", build " + r.build : "") + ", " +
      RO.day(r.t) + ", validation " + VERDICT[r.status];
  }

  // The marker beside a notch's outer end: a hollow circle (untested), a filled circle (pass),
  // a diamond (warn) or a cross (fail), so the verdict never rests on colour alone.
  function marker(g, c, status) {
    var x = c[0], y = c[1], m;
    if (status === "warn") {
      m = el("path", { d: "M" + x + " " + (y - 4.5) + "L" + (x + 4.5) + " " + y + "L" + x + " " + (y + 4.5) + "L" + (x - 4.5) + " " + y + "Z" }, g);
    } else if (status === "fail") {
      m = el("path", { d: "M" + (x - 3.5) + " " + (y - 3.5) + "L" + (x + 3.5) + " " + (y + 3.5) + "M" + (x + 3.5) + " " + (y - 3.5) + "L" + (x - 3.5) + " " + (y + 3.5) }, g);
    } else {
      m = el("circle", { cx: x, cy: y, r: 3.4 }, g);
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
      var a = angle(m), p0 = xy(a, OUTER + 16), p1 = xy(a, OUTER + 28), q = xy(a, OUTER + 44);
      el("line", { "class": "tick", x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1] }, base);
      var t = el("text", { "class": "mlabel", x: q[0], y: q[1] }, base);
      t.textContent = MONTHS[new Date(m).getUTCMonth()];
    }
    ui.date = el("text", { "class": "c-date", y: -4 }, base);
    ui.note = el("text", { "class": "c-note", y: 22 }, base);
    el("text", { "class": "c-note", y: 42 }, base).textContent = weeks + " weeks";

    var counts = {};
    fams.forEach(function (fam, i) {
      var lane = layer("lane " + famClass(fam.id));
      lane.style.setProperty("--lane", String(i));
      lane.setAttribute("data-family", fam.id);
      var rad = OUTER - i * STEP;
      el("circle", { "class": "ring", r: rad, "data-family": fam.id }, lane);
      counts[fam.id] = 0;
      all.forEach(function (r) {
        if (r.family !== fam.id || r.t < start || r.t > now) return;
        counts[fam.id]++;
        var len = LEN[r.stage], ang = angle(r.t);
        var a0 = xy(ang, rad - len / 2), a1 = xy(ang, rad + len / 2);
        var h0 = xy(ang, rad - len / 2 - 8), h1 = xy(ang, rad + len / 2 + 8);
        var g = el("g", {
          "class": "notch " + r.stage, role: "button", tabindex: "-1", "data-id": r.id,
          "data-status": r.status, "aria-label": label(r)
        }, lane);
        el("line", { "class": "hit", x1: h0[0], y1: h0[1], x2: h1[0], y2: h1[1], "stroke-width": 26 }, g);
        el("line", { "class": "nl", x1: a0[0], y1: a0[1], x2: a1[0], y2: a1[1], "stroke-width": WID[r.stage] }, g);
        marker(g, xy(ang, rad + len / 2 + 9), r.status);
        notches.push(g);
        g.rel = r;
      });
    });
    notches.sort(function (x, y) { return x.rel.t - y.rel.t; });
    if (notches.length) notches[notches.length - 1].setAttribute("tabindex", "0");

    var top = layer("hand-layer");
    top.setAttribute("aria-hidden", "true");
    ui.hand = el("g", { "class": "hand", transform: "rotate(360)" }, top);
    el("line", { "class": "hl", x1: 0, y1: -110, x2: 0, y2: -(OUTER + 20) }, ui.hand);
    el("circle", { "class": "hk", cx: 0, cy: -(OUTER + 24), r: 6 }, ui.hand);
    el("circle", { "class": "hk", cx: 0, cy: -110, r: 4 }, ui.hand);

    paintCentre();
    paintKey(fams, counts);
    document.dispatchEvent(new CustomEvent("ro:orbit"));
  }

  function paintCentre() {
    ui.date.textContent = RO.day(now);
    ui.note.textContent = "NOW";
    var out = document.getElementById("orbit-asof");
    var inWindow = notches.length;
    out.textContent = "Today, " + RO.day(now) + ": " + inWindow + (inWindow === 1 ? " release" : " releases") +
      " in the last " + weeks + " weeks.";
    var w = document.getElementById("orbit-weeks");
    if (w) w.textContent = String(weeks);
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
    if (r.build && window.Sigil) window.Sigil.draw(sig, r.build, { size: 64 });
    else sig.hidden = true;
    var text = RO.h("div", "oc-text");
    text.appendChild(RO.h("p", "oc-title", r.family + " " + RO.short(r)));
    text.appendChild(RO.h("p", "oc-build", r.build ? "Build " + r.build : "No build number"));
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
    if (!r) return;
    if (card.getAttribute("data-id") !== r.id) fill(r);
    card.hidden = false;
    place(g);
    if (pin) pinned = r.id;
  }
  function hide(force) {
    window.clearTimeout(hideTimer);
    if (pinned && !force) return;
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
  // The notch nearest to a point, within a tap's reach: the dial is small on a phone.
  function nearest(x, y, reach) {
    var best = null, bestD = reach;
    notches.forEach(function (g) {
      var r = g.getBoundingClientRect();
      var d = Math.hypot(r.left + r.width / 2 - x, r.top + r.height / 2 - y);
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
    if (g) show(g, false);
    else if (card.contains(e.target)) window.clearTimeout(hideTimer);
  });
  stage.addEventListener("pointerout", function (e) {
    if (notchOf(e.target) || card.contains(e.target)) later();
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
    if (card.contains(e.target)) return;
    var g = notchOf(e.target) || nearest(e.clientX, e.clientY, 22);
    if (!g) { hide(true); return; }
    if (pinned === g.rel.id) hide(true);
    else show(g, true);
  });
  stage.addEventListener("keydown", function (e) {
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

  RO.on(function (data) {
    if (!data) return;
    var next = data.releases.map(function (r) { return r.id + r.status; }).join("|") + "|" +
      Math.floor(Date.now() / (6 * 3600000));
    if (next === signature || stage.contains(document.activeElement)) return;
    signature = next;
    all = data.releases;
    hide(true);
    build();
  });
})();
