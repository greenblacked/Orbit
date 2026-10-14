/* Below the fold on the front page: the mock screens and the developer highlights from
   data/features.json. home.js loads this file once the page has painted and tells it the
   releases on show (Below.paint), again whenever the time machine or a data poll changes them.
   Until then the mocks are blank and their controls disabled.

   Every drawn device steps through its family's public releases, newest first (the page's own
   rule for the newest: the higher version, then the stage, the iteration and the date). Its
   hardware (side buttons, keys, sticks, a crown, straps) is a pair of real buttons, "Newer" and
   "Older"; ArrowLeft and ArrowRight do the same from anywhere inside the device (Home and End
   go to the ends), and the screen is a link to that release on the timeline. The ends are not
   wrapped: the button that cannot go on is
   aria-disabled and does nothing. The position is kept by release id, so a data poll or the
   time machine keeps the visitor on the same release when it is still listed. The iPhone also
   checks the data, the Mac switches its release channel, the iPad's sidebar picks what it steps
   through (public releases, betas or all) and the watch cycles a complication. A pick that
   drops out of the list (a data poll, the time machine) is forgotten, so the device returns to
   the newest and does not jump back later.
   The pure helpers come first; Node requires this file for tests/below.test.mjs. */
(function (global) {
  "use strict";
  var KEYS = { ArrowLeft: -1, ArrowRight: 1, Home: "first", End: "last" };

  // "Release ·" with a build after it; just "Release" when there is no build to follow.
  function trail(label, next) { return label && next ? label + " ·" : label; }
  var NUM = /^\d+([.H]\d+)*$/;
  var RANK = { beta: 0, rc: 1, release: 2 };
  function nums(v) {
    return String(v).split(/[.H]/i).map(function (n) { return parseInt(n, 10) || 0; });
  }
  function byVersion(a, b) {
    var x = nums(a), y = nums(b);
    for (var i = 0; i < Math.max(x.length, y.length); i++) {
      var d = (x[i] || 0) - (y[i] || 0);
      if (d) return d;
    }
    return 0;
  }
  // Newest first, as the page picks "the newest": the higher version (the date when either is
  // not numeric), then release over RC over beta, the iteration, the date.
  function newest(a, b) {
    var d = NUM.test(a.version) && NUM.test(b.version) ? byVersion(b.version, a.version) : b.t - a.t;
    return d || (RANK[b.stage] - RANK[a.stage]) || ((b.beta || 0) - (a.beta || 0)) || (b.t - a.t) || 0;
  }
  // What a device steps through, newest first: the family's public releases ("pub", else all
  // its releases), only its pre-releases ("pre", when it has any) or every release ("all").
  function steps(list, family, scope) {
    var mine = list.filter(function (r) { return r.family === family; });
    var pre = mine.filter(function (r) { return r.stage !== "release"; });
    var pub = mine.filter(function (r) { return r.stage === "release"; });
    var rows = scope === "all" ? mine : scope === "pre" && pre.length ? pre : pub.length ? pub : mine;
    return rows.slice().sort(newest);
  }
  // Where a release id sits in the steps: the newest (0) when it is not there.
  function index(rows, id) {
    for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return i;
    return 0;
  }
  // From step i of n: -1 or 1 for one step, "first" or "last"; never past either end.
  function move(i, n, by) {
    if (n < 1) return 0;
    return by === "first" ? 0 : by === "last" ? n - 1 : Math.min(n - 1, Math.max(0, i + by));
  }
  function keyStep(key) {
    return Object.prototype.hasOwnProperty.call(KEYS, key) ? KEYS[key] : null;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      trail: trail, steps: steps, index: index, move: move, keyStep: keyStep, newest: newest
    };
    return;
  }

  var RO = global.RO;
  if (!RO) return;
  var releases = [];
  var picked = {};
  var iosChecked = false;
  var channel = "release";
  var scope = "pub";
  var mode = 0;
  var MODES = ["Version", "Build", "Released"];

  function text(root, name, value) {
    var els = root.querySelectorAll('[data-f="' + name + '"]');
    for (var i = 0; i < els.length; i++) els[i].textContent = value;
  }

  function sec(family) { return document.querySelector('section.fam[data-family="' + family + '"]'); }
  function label(r) { return r.family + " " + RO.short(r) + (r.build ? " (" + r.build + ")" : ""); }
  function newestBeta(family) {
    for (var i = 0; i < releases.length; i++) {
      if (releases[i].family === family && releases[i].stage !== "release") return releases[i];
    }
    return null;
  }
  // What a device shows: the release it is on (rows[i]), or on the Mac's beta channel the beta.
  function shown(family) {
    var rows = steps(releases, family, family === "iPadOS" ? ipadScope() : "pub");
    var i = index(rows, picked[family]);
    if (rows[i] && rows[i].id !== picked[family]) delete picked[family];
    var beta = family === "macOS" && channel === "beta" ? RO.lead(releases, family).pre : null;
    return { rows: rows, i: i, r: beta || rows[i] || null, beta: !!beta };
  }
  function where(s) { return s.beta ? "beta channel" : s.i + 1 + " of " + s.rows.length; }
  // The name, stage, build and date on each mock screen, its position and its link, and
  // whether its hardware can go on. The Mac's are repainted by paintMac.
  function paintFields(only) {
    var all = document.querySelectorAll("section.fam");
    for (var i = 0; i < all.length; i++) {
      var box = all[i];
      var family = box.getAttribute("data-family");
      if (only && only !== family) continue;
      var s = shown(family);
      var r = s.r;
      var link = box.querySelector(".m-link");
      var btns = box.querySelectorAll("[data-step]");
      text(box, "name", r ? r.family + " " + RO.short(r) : family);
      text(box, "stage", r ? trail(RO.stageLabel(r), r.build) : "");
      text(box, "build", r && r.build ? "Build " + r.build : "");
      text(box, "date", r ? "Published " + RO.day(r.t) : "");
      text(box, "pos", !r ? "" : s.beta ? "Beta" : s.i + 1 + " / " + s.rows.length);
      if (link && r) {
        link.setAttribute("href", "/timeline/?id=" + encodeURIComponent(r.id));
        link.setAttribute("aria-label", "Open " + label(r) + " on the timeline, " + where(s));
      } else if (link) {
        link.removeAttribute("href");
        link.removeAttribute("aria-label");
      }
      for (var j = 0; j < btns.length; j++) {
        var back = Number(btns[j].getAttribute("data-step")) < 0;
        btns[j].disabled = !r;
        btns[j].setAttribute("aria-disabled", String(!r || s.beta || (back ? s.i === 0 : s.i === s.rows.length - 1)));
      }
    }
  }
  function said(s) { return label(s.r) + ", " + where(s); }
  function paintIos() {
    var box = sec("iOS");
    var out = box.querySelector('[data-f="result"]');
    var btn = box.querySelector('[data-act="check"]');
    if (!out) return;
    btn.disabled = false;
    var latestPub = RO.latest(releases, "iOS", true);
    var latestBeta = newestBeta("iOS");
    text(box, "pubrow", latestPub ? latestPub.version : "None");
    text(box, "betarow", latestBeta && (!latestPub || latestBeta.t > latestPub.t) ? RO.short(latestBeta) : "None");
    btn.removeAttribute("aria-busy");
    btn.textContent = iosChecked ? "Check again" : "Check the data";
    if (!iosChecked) { out.textContent = ""; return; }
    var pub = RO.latest(releases, "iOS", true);
    var beta = newestBeta("iOS");
    var line = pub ? label(pub) + " is the latest release, published " + RO.day(pub.t) + "." : "No iOS release in the data.";
    if (beta && (!pub || beta.t > pub.t)) line += " The newest beta is " + label(beta) + ".";
    out.textContent = line;
  }
  function paintMac(announce) {
    var box = sec("macOS");
    var seg = box.querySelectorAll("[data-ch]");
    if (!seg.length) return;
    var beta = RO.lead(releases, "macOS").pre;
    if (!beta) channel = "release";
    var s = shown("macOS");
    var r = s.r;
    for (var i = 0; i < seg.length; i++) {
      seg[i].setAttribute("aria-pressed", String(seg[i].getAttribute("data-ch") === channel));
    }
    seg[0].disabled = false;
    seg[1].disabled = !beta;
    seg[1].setAttribute("aria-disabled", String(!beta));
    text(box, "betanote", beta ? "" : "No newer beta");
    text(box, "name", r ? r.family + " " + RO.short(r) : "macOS");
    text(box, "version", r ? r.version : "None in the data");
    text(box, "build", r && r.build ? r.build : "None");
    text(box, "date", r ? RO.day(r.t) : "None");
    if (announce && r) text(box, "step", said(s));
  }
  // The chosen tab, unless it has nothing to show (no beta on the day shown): the choice itself is
  // kept, so it applies again once betas return.
  function ipadScope() {
    var hasPre = steps(releases, "iPadOS", "pre").some(function (r) { return r.stage !== "release"; });
    return scope === "pre" && !hasPre ? "pub" : scope;
  }
  function paintIpad() {
    var box = sec("iPadOS");
    var tabs = box.querySelectorAll("[data-scope]");
    if (!tabs.length) return;
    var hasPre = steps(releases, "iPadOS", "pre").some(function (r) { return r.stage !== "release"; });
    var now = ipadScope();
    for (var i = 0; i < tabs.length; i++) {
      var mine = tabs[i].getAttribute("data-scope");
      var off = mine === "pre" && !hasPre;
      tabs[i].disabled = off;
      tabs[i].setAttribute("aria-pressed", String(mine === now));
      tabs[i].setAttribute("aria-disabled", String(off));
    }
  }
  function paintWatch(announce) {
    var box = sec("watchOS");
    var v = box.querySelector('[data-f="v"]');
    if (!v) return;
    box.querySelector('[data-act="cycle"]').disabled = false;
    var r = shown("watchOS").r;
    var values = r ? [r.version, r.build || "None", RO.day(r.t).replace(/, \d{4}$/, "")] : ["None", "None", "None"];
    text(box, "k", MODES[mode]);
    text(box, "v", values[mode]);
    if (announce) text(box, "said", "Showing " + MODES[mode].toLowerCase() + " " + values[mode]);
  }
  // One device after a step; the others and the iPhone's rows do not depend on it.
  function stepTo(family, by) {
    var s = shown(family);
    var j = move(s.i, s.rows.length, by);
    if (s.beta || !s.rows.length || j === s.i) return;
    picked[family] = s.rows[j].id;
    paintFields(family);
    if (family === "macOS") paintMac(false);
    if (family === "watchOS") paintWatch(false);
    text(sec(family), "step", said(shown(family)));
  }
  function wireDevice(box) {
    var family = box.getAttribute("data-family");
    var dev = box.querySelector(".dev");
    var btns = box.querySelectorAll("[data-step]");
    for (var j = 0; j < btns.length; j++) {
      btns[j].addEventListener("click", function (e) {
        stepTo(family, Number(e.currentTarget.getAttribute("data-step")));
      });
    }
    if (dev) dev.addEventListener("keydown", function (e) {
      var by = keyStep(e.key);
      if (by === null || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (!shown(family).rows.length) return;
      e.preventDefault();
      stepTo(family, by);
    });
  }

  function wire() {
    var boxes = document.querySelectorAll("section.fam");
    for (var k = 0; k < boxes.length; k++) wireDevice(boxes[k]);
    var ios = sec("iOS").querySelector('[data-act="check"]');
    if (ios) ios.addEventListener("click", function () {
      var out = sec("iOS").querySelector('[data-f="result"]');
      ios.setAttribute("aria-busy", "true");
      ios.textContent = "Checking…";
      out.textContent = "Checking the data…";
      window.setTimeout(function () { iosChecked = true; paintIos(); }, RO.reduced() ? 0 : 900);
    });
    var seg = sec("macOS").querySelectorAll("[data-ch]");
    for (var i = 0; i < seg.length; i++) seg[i].addEventListener("click", function (e) {
      channel = e.currentTarget.getAttribute("data-ch");
      paintFields("macOS");
      paintMac(true);
    });
    var tabs = sec("iPadOS").querySelectorAll("[data-scope]");
    for (var t = 0; t < tabs.length; t++) tabs[t].addEventListener("click", function (e) {
      var pick = e.currentTarget.getAttribute("data-scope");
      if (pick === ipadScope()) return;
      scope = pick;
      paintIpad();
      paintFields("iPadOS");
      text(sec("iPadOS"), "step", said(shown("iPadOS")));
    });
    var comp = sec("watchOS").querySelector('[data-act="cycle"]');
    if (comp) comp.addEventListener("click", function () {
      mode = (mode + 1) % MODES.length;
      paintWatch(true);
    });
  }
  wire();

  // Developer highlights from data/features.json: a short summary of each, linked to the
  // vendor's own page. The section stays hidden when the file is empty or unreadable.
  function paintFeatures(items) {
    var box = document.getElementById("features");
    var host = document.getElementById("features-list");
    var ids = RO.familyIds();
    var good = (Array.isArray(items) ? items : []).filter(function (f) {
      return f && ids.indexOf(f.family) >= 0 && typeof f.title === "string" &&
        typeof f.summary === "string" && typeof f.vendor === "string" &&
        typeof f.source === "string" && RO.allowed(f.vendor, f.source);
    });
    if (!box || !good.length) return;
    host.textContent = "";
    ids.forEach(function (family) {
      var mine = good.filter(function (f) { return f.family === family; });
      if (!mine.length) return;
      var group = RO.h("div", "feat-group fam-" + family.toLowerCase());
      group.appendChild(RO.h("h3", "feat-fam", family + " " + mine[0].major));
      var ul = RO.h("ul", "feat-list");
      mine.forEach(function (f) {
        var li = RO.h("li", "feat");
        li.appendChild(RO.h("p", "feat-title", f.title));
        li.appendChild(RO.h("p", "feat-sum", f.summary));
        var a = RO.h("a", "rel-apple", "Read more", { href: f.source, target: "_blank", rel: "noopener noreferrer" });
        a.appendChild(RO.h("span", "sr-only", " about " + f.title + " (opens in a new tab)"));
        li.appendChild(a);
        ul.appendChild(li);
      });
      group.appendChild(ul);
      host.appendChild(group);
    });
    box.hidden = false;
  }

  window.Below = {
    paint: function (list) {
      releases = list;
      // A poll or the time machine changes what is listed: the last step's words are stale.
      text(document, "step", "");
      paintIpad();
      paintFields();
      paintIos();
      paintMac(false);
      paintWatch(false);
    }
  };
  Promise.all([RO.loadJson("/data/features.json"), RO.ready()]).then(function (all) {
    paintFeatures(all[0]);
  }, function () {});
})(typeof window !== "undefined" ? window : this);
