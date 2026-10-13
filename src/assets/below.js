/* Below the fold on the front page: the mock screens (a data check on iPhone, a release
   channel switch on Mac, a watch complication) and the developer highlights from
   data/features.json. home.js loads this file once the page has painted and tells it the
   releases on show (Below.paint), again whenever the time machine changes them. Until then
   the mocks are blank and their controls disabled. */
(function () {
  "use strict";
  var RO = window.RO;
  if (!RO) return;
  var releases = [];
  var iosChecked = false;
  var channel = "release";
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
  // The name, stage, build and date on each mock screen. The Mac's are repainted by paintMac.
  function paintFields() {
    var all = document.querySelectorAll("section.fam");
    for (var i = 0; i < all.length; i++) {
      var family = all[i].getAttribute("data-family");
      var r = RO.lead(releases, family).main;
      text(all[i], "name", r ? r.family + " " + RO.short(r) : family);
      text(all[i], "stage", r ? RO.stageLabel(r) + " ·" : "");
      text(all[i], "build", r && r.build ? "Build " + r.build : "");
      text(all[i], "date", r ? "Published " + RO.day(r.t) : "");
    }
  }
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
  function paintMac() {
    var box = sec("macOS");
    var seg = box.querySelectorAll("[data-ch]");
    if (!seg.length) return;
    var beta = RO.lead(releases, "macOS").pre;
    if (!beta) channel = "release";
    var r = channel === "beta" ? beta : RO.latest(releases, "macOS", true);
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
  }
  function paintWatch(announce) {
    var box = sec("watchOS");
    var v = box.querySelector('[data-f="v"]');
    if (!v) return;
    box.querySelector('[data-act="cycle"]').disabled = false;
    var r = RO.lead(releases, "watchOS").main;
    var values = r ? [r.version, r.build || "None", RO.day(r.t).replace(/, \d{4}$/, "")] : ["None", "None", "None"];
    text(box, "k", MODES[mode]);
    text(box, "v", values[mode]);
    if (announce) text(box, "said", "Showing " + MODES[mode].toLowerCase() + " " + values[mode]);
  }

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

  window.Below = {
    paint: function (list) {
      releases = list;
      paintFields();
      paintIos();
      paintMac();
      paintWatch(false);
    }
  };
  Promise.all([RO.loadJson("/data/features.json"), RO.ready()]).then(function (all) {
    paintFeatures(all[0]);
  }, function () {});
})();
