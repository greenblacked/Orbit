/* Front page: the live indicator and, per platform family, its latest release and section.
   The mock screens and the developer highlights are below.js, loaded once the page has painted. */
(function () {
  "use strict";
  var RO = window.RO;
  var live = document.getElementById("live");
  var liveText = document.getElementById("live-text");
  var cards = document.querySelectorAll("#latest-grid [data-family]");
  var sections = document.querySelectorAll("section.fam");
  var signature = "";
  var current = [];

  function setLive(kind, text) {
    live.setAttribute("data-state", kind);
    liveText.textContent = text;
  }
  function paintLive(data, failed) {
    if (!data) {
      setLive("error", failed ? "Could not load releases. The source is linked below." : "Loading…");
      return;
    }
    var when = data.fetchedAt ? RO.stamp(data.fetchedAt) : "";
    if (failed) setLive("stale", "Could not reach the tracker, showing data from " + when);
    else if (data.stale) setLive("stale", "Stale: the source was unreachable, showing the last copy from " + when);
    else if (data.snapshot) setLive("snapshot", "Saved copy from " + when + ", not live");
    else setLive("live", "Live: fetched at " + when);
  }

  // The sigil of a build and a line that reads two of its parameters.
  function paintSigil(card, r) {
    var row = card.querySelector(".rel-sig");
    var host = card.querySelector('[data-f="sigil"]');
    if (!row || !window.Sigil) return;
    var build = (r && r.build) || "";
    // A deferred paint for an earlier build must not land.
    card.setAttribute("data-sigil-want", build);
    row.hidden = !build;
    window.Sigil.draw(host, build, { size: 72 });
    var text = "";
    if (build) {
      var p = window.Sigil.parse(build);
      if (p.pending) {
        window.Sigil.ready(function () {
          if (card.getAttribute("data-sigil-want") === build) paintSigil(card, r);
        }, card.querySelector('[data-f="sigtxt"]'));
      } else text = "Build sigil: " + p.rings + (p.rings === 1 ? " ring" : " rings") +
        (p.dots ? ", " + p.dots + (p.dots === 1 ? " dot" : " dots") : "");
    }
    card.querySelector('[data-f="sigtxt"]').textContent = text;
  }

  function paintCard(card, r) {
    var set = function (name, text) { card.querySelector('[data-f="' + name + '"]').textContent = text; };
    paintSigil(card, r);
    if (!r) {
      set("ver", "No release yet");
      ["stage", "build", "when"].forEach(function (name) { set(name, ""); });
      set("major", "—");
      card.removeAttribute("data-stage");
      card.querySelector('[data-f="badge"]').hidden = true;
      card.querySelector('[data-f="link"]').hidden = true;
      return;
    }
    set("ver", r.family + " " + r.version);
    set("stage", RO.stageLabel(r));
    set("build", r.build ? "Build " + r.build : "");
    card.setAttribute("data-stage", r.stage);
    var tile = card.querySelector('[data-f="major"]');
    tile.textContent = String(r.major);
    var when = card.querySelector('[data-f="when"]');
    when.textContent = "";
    when.appendChild(document.createTextNode(RO.day(r.t) + " · "));
    when.appendChild(RO.when(r.t));
    var link = card.querySelector('[data-f="link"]');
    link.href = r.url;
    link.hidden = false;
    card.querySelector('[data-f="badge"]').hidden = false;
  }

  function text(root, name, value) {
    var els = root.querySelectorAll('[data-f="' + name + '"]');
    for (var i = 0; i < els.length; i++) els[i].textContent = value;
  }
  function external(link) {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.appendChild(RO.h("span", "sr-only", " (opens in a new tab)"));
  }
  function paintSection(sec, list) {
    var family = sec.getAttribute("data-family");
    var r = RO.latest(list, family, false);
    var recent = sec.querySelector('[data-f="recent"]');
    recent.textContent = "";
    var shown = list.filter(function (x) { return x.family === family; }).slice(0, 5);
    shown.forEach(function (x) {
      var item = RO.h("li");
      var a = RO.h("a", "", null, { href: x.url });
      // In the document before any mark draws: a draw that waits for the sigil rule keeps its
      // place in the queue only while its mark is connected.
      item.appendChild(a);
      recent.appendChild(item);
      if (x.build && window.Sigil) {
        var mark = RO.h("span", "r-sig");
        a.appendChild(mark);
        window.Sigil.draw(mark, x.build, { size: 28, birth: false });
      }
      a.appendChild(RO.h("span", "r-ver", x.version));
      a.appendChild(RO.h("span", "r-stage", RO.stageLabel(x)));
      if (x.build) a.appendChild(RO.h("span", "r-build", x.build));
      a.appendChild(RO.h("span", "r-date", RO.day(x.t)));
      external(a);
    });
    // The mock screens' fields (name, stage, build, date, version) are below.js's to paint.
    text(sec, "latest", r
      ? "Newest: " + r.title + ", " + RO.day(r.t)
      : "No " + family + " release in the data" + (asOf === null ? " yet." : " by then."));
  }

  // The time machine (orbit.js) sets asOf: the releases after that day are left out of
  // everything below the dial, as if it were that day. null is now.
  var all = [];
  var asOf = null;
  function render() {
    var list = asOf === null ? all : all.filter(function (r) { return r.t <= asOf; });
    var next = list.map(function (r) { return r.id; }).join("|");
    var note = document.getElementById("latest-asof");
    if (note) {
      note.hidden = asOf === null;
      note.textContent = asOf === null ? "" : "Time machine: showing the releases as of " + RO.day(asOf) + ".";
    }
    if (next === signature) return;
    signature = next;
    for (var i = 0; i < cards.length; i++) {
      paintCard(cards[i], RO.latest(list, cards[i].getAttribute("data-family"), false));
    }
    current = list;
    for (var j = 0; j < sections.length; j++) paintSection(sections[j], list);
    if (window.Below) window.Below.paint(list);
  }
  document.addEventListener("ro:asof", function (e) {
    asOf = e.detail && typeof e.detail.t === "number" ? e.detail.t : null;
    render();
  });

  RO.on(function (data, fresh, failed) {
    paintLive(data, failed);
    if (!data) return;
    all = data.releases;
    render();
  });

  // Three scripts load after the page has painted, never from the HTML. below.js (the mock
  // screens and the developer highlights, all below the fold) as soon as the page has loaded,
  // and told the releases on show when it arrives; the cadence row under the dial (also told
  // the day the hand points at) and, when motion is allowed, the visual effects module once
  // the browser is idle. The preview bundle (which embeds its data) has no files to load.
  function load(src, type, onload) {
    var s = document.createElement("script");
    s.src = src;
    if (type) s.type = type;
    if (onload) s.onload = onload;
    document.head.appendChild(s);
  }
  function loadBelow() {
    // No onerror: the mock screens start out neutral and inert, and stay so if this fails.
    load("/assets/below.js", "", function () { if (signature && window.Below) window.Below.paint(current); });
  }
  function loadLater() {
    load("/assets/cadence.js", "", function () { if (window.Cadence) window.Cadence.at(asOf); });
    if (!RO.reduced()) load("/assets/fx.js", "module");
  }
  function afterPaint() {
    if (document.querySelector("script[data-seed]")) return;
    loadBelow();
    if ("requestIdleCallback" in window) window.requestIdleCallback(loadLater, { timeout: 1500 });
    else window.setTimeout(loadLater, 1000);
  }
  if (document.readyState === "complete") afterPaint();
  else window.addEventListener("load", afterPaint);
})();
