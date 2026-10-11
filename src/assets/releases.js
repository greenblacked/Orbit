/* Release data for every page: loads the families config (/data/families.json) and
   /api/releases.json (the Worker), falls back to the bundled /data/releases.json, polls
   every five minutes while the page is visible, and tells a toast (aria-live) when ids the
   page has not shown before appear. Pages ask for the data with RO.on(fn). Nothing here
   writes HTML from data: text goes in with textContent and a link only if it points at the
   host its vendor's source allows. */
(function () {
  "use strict";
  var API = "/api/releases.json";
  var SNAPSHOT = "/data/releases.json";
  var CONFIG = "/data/families.json";
  var POLL = 5 * 60 * 1000;
  var STAGES = ["release", "beta", "rc"];
  // A validation verdict may come with a release once results exist; without one it is untested.
  var VERDICTS = ["pass", "warn", "fail"];
  // Used when the families config cannot be read: Apple is the only vendor so far.
  var FALLBACK = { name: "Apple Developer Releases", url: "https://developer.apple.com/news/releases/", hosts: ["developer.apple.com"] };

  var config = { families: [], vendors: [] };
  var state = { data: null, known: null, at: 0, failed: false, busy: false };
  var listeners = [];
  var toastTimer = 0;

  function parts(v) {
    return String(v).split(".").map(function (n) { return parseInt(n, 10) || 0; });
  }
  function compareVersions(a, b) {
    var x = parts(a), y = parts(b);
    for (var i = 0; i < Math.max(x.length, y.length); i++) {
      var d = (x[i] || 0) - (y[i] || 0);
      if (d) return d;
    }
    return 0;
  }
  var RANK = { beta: 0, rc: 1, release: 2 };
  // Newest first: by date, then by version, then release over RC over beta.
  function newer(a, b) {
    return (b.t - a.t) || compareVersions(b.version, a.version) ||
      (RANK[b.stage] - RANK[a.stage]) || ((b.beta || 0) - (a.beta || 0)) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  function familyIds() { return config.families.map(function (f) { return f.id; }); }
  function familyOf(id) {
    for (var i = 0; i < config.families.length; i++) if (config.families[i].id === id) return config.families[i];
    return null;
  }
  // The source a vendor's data comes from: its name, page and the hosts its links may use.
  function source(vendor) {
    for (var i = 0; i < config.vendors.length; i++) {
      if (config.vendors[i].id === vendor && config.vendors[i].source) return config.vendors[i].source;
    }
    return FALLBACK;
  }
  function allowed(vendor, link) {
    try {
      var u = new URL(link);
      return u.protocol === "https:" && source(vendor).hosts.indexOf(u.hostname) >= 0;
    } catch (e) { return false; }
  }
  // The config is a convenience for ordering and accents: without it, any family name the
  // data brings is accepted, still only with a link its vendor's source allows.
  function knownFamily(r) {
    if (!config.families.length) return typeof r.family === "string" && r.family !== "";
    var f = familyOf(r.family);
    return !!f && f.vendor === r.vendor;
  }

  // Keep only entries the pages can show safely; null when nothing usable is left.
  function normalise(json) {
    if (!json || !Array.isArray(json.releases)) return null;
    var seen = {};
    var list = [];
    json.releases.forEach(function (r) {
      if (!r || typeof r.id !== "string" || seen[r.id] || typeof r.vendor !== "string") return;
      var t = Date.parse(r.date);
      if (!knownFamily(r) || STAGES.indexOf(r.stage) < 0 || isNaN(t)) return;
      if (typeof r.version !== "string" || typeof r.url !== "string") return;
      if (!allowed(r.vendor, r.url)) return;
      seen[r.id] = true;
      list.push({
        id: r.id, vendor: r.vendor, family: r.family, version: r.version,
        major: Number(r.major) || parts(r.version)[0],
        stage: r.stage, beta: typeof r.beta === "number" ? r.beta : null,
        build: typeof r.build === "string" ? r.build : "",
        status: VERDICTS.indexOf(r.status) >= 0 ? r.status : "untested",
        title: typeof r.title === "string" ? r.title : r.family + " " + r.version,
        date: new Date(t).toISOString(), t: t, url: r.url
      });
    });
    if (!list.length) return null;
    list.sort(newer);
    var fetched = Date.parse(json.fetchedAt);
    return {
      releases: list,
      fetchedAt: isNaN(fetched) ? null : fetched,
      stale: json.stale === true,
      snapshot: json.snapshot === true
    };
  }

  // The preview bundle cannot fetch: it embeds data/*.json as data-seed blocks instead.
  function seeded(url) {
    var key = url === API ? SNAPSHOT : url;
    var el = document.querySelector('script[data-seed="' + key + '"]');
    return el ? new Promise(function (ok) { ok(JSON.parse(el.textContent)); }) : null;
  }
  function loadJson(url) {
    return seeded(url) || fetch(url, { headers: { accept: "application/json" } }).then(function (res) {
      var kind = res.headers.get("content-type") || "";
      if (!res.ok || kind.indexOf("json") < 0) throw new Error("not json: " + url);
      return res.json();
    });
  }
  function getJson(url) {
    return loadJson(url).then(function (json) {
      var data = normalise(json);
      if (!data) throw new Error("no releases in " + url);
      return data;
    });
  }
  // The families config loads once, before the first data is read.
  var ready = null;
  function loadConfig() {
    if (!ready) {
      ready = loadJson(CONFIG).then(function (json) {
        if (json && Array.isArray(json.families) && Array.isArray(json.vendors)) config = json;
      }, function () { /* the pages still work without it, see knownFamily */ });
    }
    return ready;
  }
  function refresh() {
    if (state.busy) return Promise.resolve();
    state.busy = true;
    // The bundled snapshot is only for a first load: a later failed poll keeps the data
    // already on screen (it may be newer than the snapshot) and says it could not refresh.
    return loadConfig().then(function () { return getJson(API); }).catch(function (err) {
      if (state.data) throw err;
      return getJson(SNAPSHOT);
    }).then(function (data) {
      var fresh = [];
      if (state.known) {
        fresh = data.releases.filter(function (r) { return !state.known[r.id]; });
      }
      state.known = state.known || {};
      data.releases.forEach(function (r) { state.known[r.id] = true; });
      state.data = data;
      state.failed = false;
      state.at = Date.now();
      if (fresh.length) announce(fresh);
      listeners.forEach(function (fn) { fn(data, fresh); });
    }, function () {
      state.failed = true;
      listeners.forEach(function (fn) { fn(state.data, [], true); });
    }).then(function () { state.busy = false; });
  }

  function on(fn) {
    listeners.push(fn);
    if (state.data) fn(state.data, [], state.failed);
    else if (state.failed) fn(null, [], true);
  }

  // Elements: h("a", "pill", "text", {href: "/"}).
  function h(tag, cls, text, attrs) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    if (attrs) for (var k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  var dayFormat, stampFormat, relFormat;
  try {
    dayFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
    stampFormat = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium", timeStyle: "short", timeZone: "UTC"
    });
  } catch (e) { /* older engines fall back to ISO text below */ }
  try { relFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" }); } catch (e) {}

  function day(t) { return dayFormat ? dayFormat.format(t) : new Date(t).toISOString().slice(0, 10); }
  function stamp(t) {
    return stampFormat ? stampFormat.format(t) + " UTC" : new Date(t).toISOString();
  }
  function month(t) {
    var d = new Date(t);
    var names = ["January", "February", "March", "April", "May", "June", "July", "August",
      "September", "October", "November", "December"];
    return names[d.getUTCMonth()] + " " + d.getUTCFullYear();
  }
  function ago(t) {
    var s = Math.round((t - Date.now()) / 1000);
    var a = Math.abs(s);
    var unit = a < 60 ? "second" : a < 3600 ? "minute" : a < 86400 ? "hour" : "day";
    var size = { second: 1, minute: 60, hour: 3600, day: 86400 }[unit];
    var n = Math.round(s / size);
    if (unit === "second") return "just now";
    if (relFormat) return relFormat.format(n, unit);
    n = Math.abs(n);
    return n + " " + unit + (n === 1 ? "" : "s") + (s < 0 ? " ago" : " from now");
  }
  function stageLabel(r) {
    if (r.stage === "release") return "Release";
    if (r.stage === "beta") return r.beta ? "Beta " + r.beta : "Beta";
    return r.beta ? "RC " + r.beta : "RC";
  }
  // "27.2 beta 3" for a release's version and stage, without the OS name.
  function short(r) {
    return r.version + (r.stage === "release" ? "" : " " + stageLabel(r).toLowerCase());
  }
  function latest(list, family, publicOnly) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].family === family && (!publicOnly || list[i].stage === "release")) return list[i];
    }
    return null;
  }
  function when(t) {
    var el = h("time", "when", ago(t), { datetime: new Date(t).toISOString() });
    el.setAttribute("data-rel", String(t));
    return el;
  }
  function tick() {
    var els = document.querySelectorAll("time[data-rel]");
    for (var i = 0; i < els.length; i++) els[i].textContent = ago(Number(els[i].getAttribute("data-rel")));
  }

  function announce(fresh) {
    var box = document.getElementById("toast");
    if (!box) return;
    var names = fresh.slice(0, 3).map(function (r) { return r.title.replace(/ \(.*\)$/, ""); });
    var text = "New: " + names.join(", ") +
      (fresh.length > 3 ? " and " + (fresh.length - 3) + " more" : "") + ".";
    box.textContent = "";
    box.appendChild(h("p", "toast-text", text));
    var close = h("button", "toast-close", "Dismiss", { type: "button" });
    close.addEventListener("click", hideToast);
    box.appendChild(close);
    box.classList.add("on");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(hideToast, 12000);
  }
  function hideToast() {
    var box = document.getElementById("toast");
    if (box) box.classList.remove("on");
  }

  function visible() { return document.visibilityState === "visible"; }
  window.setInterval(function () { if (visible()) refresh(); }, POLL);
  window.setInterval(function () { if (visible()) tick(); }, 60000);
  document.addEventListener("visibilitychange", function () {
    if (visible() && Date.now() - state.at > POLL) refresh();
    if (visible()) tick();
  });

  window.RO = {
    loadJson: loadJson, ready: loadConfig, families: function () { return config.families; },
    familyIds: familyIds, source: source, allowed: allowed, h: h, on: on, refresh: refresh, day: day, stamp: stamp,
    month: month, ago: ago, when: when, tick: tick, stageLabel: stageLabel, short: short,
    latest: latest, newer: newer, compareVersions: compareVersions,
    reduced: function () {
      return !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }
  };
  // Scroll reveals without animation-timeline: below-the-fold .reveal elements get .pre, and
  // .in when they scroll into view. The script only adds classes; the CSS does the rest, and
  // everything stays visible if this never runs.
  (function reveal() {
    var els = document.querySelectorAll(".reveal");
    if (!els.length || !("IntersectionObserver" in window) || !window.matchMedia) return;
    if (!window.matchMedia("(prefers-reduced-motion: no-preference)").matches) return;
    if (window.CSS && CSS.supports && CSS.supports("animation-timeline: view()")) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add("in");
        io.unobserve(e.target);
      });
    }, { rootMargin: "0px 0px -8% 0px" });
    for (var i = 0; i < els.length; i++) {
      if (els[i].getBoundingClientRect().top > window.innerHeight) {
        els[i].classList.add("pre");
        io.observe(els[i]);
      }
    }
  })();
  refresh();
})();
