/* Front page: the live indicator and, per platform family, its latest release and section,
   and the developer highlights. */
(function () {
  "use strict";
  var RO = window.RO;
  var live = document.getElementById("live");
  var liveText = document.getElementById("live-text");
  var cards = document.querySelectorAll("#latest-grid [data-family]");
  var sections = document.querySelectorAll("section.fam");
  var signature = "";
  var releases = [];
  var iosChecked = false;
  var channel = "release";
  var mode = 0;
  var MODES = ["Version", "Build", "Released"];

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

  function paintCard(card, r) {
    var set = function (name, text) { card.querySelector('[data-f="' + name + '"]').textContent = text; };
    if (!r) { set("ver", "No release yet"); return; }
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
      a.appendChild(RO.h("span", "r-ver", x.version));
      a.appendChild(RO.h("span", "r-stage", RO.stageLabel(x)));
      if (x.build) a.appendChild(RO.h("span", "r-build", x.build));
      a.appendChild(RO.h("span", "r-date", RO.day(x.t)));
      external(a);
      item.appendChild(a);
      recent.appendChild(item);
    });
    if (!r) { text(sec, "latest", "No " + family + " release in the data yet."); return; }
    text(sec, "latest", "Newest: " + r.title + ", " + RO.day(r.t));
    text(sec, "name", r.family + " " + RO.short(r));
    text(sec, "stage", RO.stageLabel(r) + " ·");
    text(sec, "build", r.build ? "Build " + r.build : "");
    text(sec, "date", "Published " + RO.day(r.t));
    text(sec, "version", r.version);
  }

  // The mock screens: a data check on iPhone, a release channel switch on Mac, a watch complication.
  function sec(family) { return document.querySelector('section.fam[data-family="' + family + '"]'); }
  function label(r) { return r.family + " " + RO.short(r) + (r.build ? " (" + r.build + ")" : ""); }
  function newestBeta(family) {
    for (var i = 0; i < releases.length; i++) {
      if (releases[i].family === family && releases[i].stage !== "release") return releases[i];
    }
    return null;
  }
  function paintIos() {
    var box = sec("iOS");
    var out = box.querySelector('[data-f="result"]');
    var btn = box.querySelector('[data-act="check"]');
    if (!out) return;
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
  function paintMac() {
    var box = sec("macOS");
    var seg = box.querySelectorAll("[data-ch]");
    if (!seg.length) return;
    var beta = newestBeta("macOS");
    var r = channel === "beta" ? beta : RO.latest(releases, "macOS", true);
    for (var i = 0; i < seg.length; i++) {
      seg[i].setAttribute("aria-pressed", String(seg[i].getAttribute("data-ch") === channel));
    }
    seg[1].disabled = !beta;
    text(box, "name", r ? r.family + " " + RO.short(r) : "macOS");
    text(box, "version", r ? r.version : "None in the data");
    text(box, "build", r && r.build ? r.build : "None");
    text(box, "date", r ? RO.day(r.t) : "None");
  }
  function paintWatch(announce) {
    var box = sec("watchOS");
    var v = box.querySelector('[data-f="v"]');
    if (!v) return;
    var r = RO.latest(releases, "watchOS", false);
    var values = r ? [r.version, r.build || "None", RO.day(r.t).replace(/, \d{4}$/, "")] : ["None", "None", "None"];
    text(box, "k", MODES[mode]);
    text(box, "v", values[mode]);
    if (announce) text(box, "said", "Showing " + MODES[mode].toLowerCase() + " " + values[mode]);
  }
  function paintMocks() { paintIos(); paintMac(); paintWatch(false); }

  function wire() {
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
      paintMac();
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
  Promise.all([RO.loadJson("/data/features.json"), RO.ready()]).then(function (all) {
    paintFeatures(all[0]);
  }, function () {});

  RO.on(function (data, fresh, failed) {
    paintLive(data, failed);
    if (!data) return;
    var next = data.releases.map(function (r) { return r.id; }).join("|");
    if (next === signature) return;
    signature = next;
    for (var i = 0; i < cards.length; i++) {
      paintCard(cards[i], RO.latest(data.releases, cards[i].getAttribute("data-family"), false));
    }
    releases = data.releases;
    for (var j = 0; j < sections.length; j++) paintSection(sections[j], data.releases);
    paintMocks();
  });
})();
