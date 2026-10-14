/* Release data for every page: loads the families config and /api/releases.json (the Worker),
   falls back to the bundled /data/releases.json, polls every five minutes while the page is
   visible, and tells a toast (aria-live) about new ids. Pages ask with RO.on(fn). Nothing here
   writes HTML from data: text goes in with textContent, a link only to its vendor's hosts. */
(function () {
  "use strict";
  var API = "/api/releases.json";
  var SNAPSHOT = "/data/releases.json";
  var CONFIG = "/data/families.json";
  var NOTES = "/data/notes.json";
  var SUMMARY_MAX = 200;
  var POLL = 5 * 60 * 1000;
  var STAGES = ["release", "beta", "rc"];
  // Only a released build may carry a verdict (docs/adr/0005).
  var VERDICTS = ["pass", "warn", "fail"];
  // Used when the families config cannot be read.
  var FALLBACK = { name: "Apple Developer Releases", url: "https://developer.apple.com/news/releases/", hosts: ["developer.apple.com"] };

  var config = { families: [], vendors: [] };
  var state = { data: null, known: null, at: 0, failed: false, busy: false };
  var listeners = [];
  var toastTimer = 0;

  // "26H2" splits into [26, 2], so a second half-year sorts above the first.
  function parts(v) {
    return String(v).split(/[.H]/i).map(function (n) { return parseInt(n, 10) || 0; });
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
  // A vendor's source: its name, page and allowed link hosts.
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
  // Without the config any family name is accepted, with its vendor's links only.
  function knownFamily(r) {
    if (!config.families.length) return typeof r.family === "string" && r.family !== "";
    var f = familyOf(r.family);
    return !!f && f.vendor === r.vendor;
  }

  // A summary is one line of plain text (deploy/releases.js cleanSummary): written with
  // textContent only, never as markup. Anything that is not a string is dropped.
  function summary(v) {
    if (typeof v !== "string") return "";
    var t = v.replace(/[\t\n\r\u2028\u2029]+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "").replace(/\s+/g, " ").trim();
    if (t.length <= SUMMARY_MAX) return t;
    var room = t.slice(0, SUMMARY_MAX - 1);
    var last = room.charCodeAt(room.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) room = room.slice(0, -1);
    var space = room.lastIndexOf(" ");
    return (space >= SUMMARY_MAX / 2 ? room.slice(0, space) : room).replace(/[\s.,;:!?-]+$/, "") + "\u2026";
  }

  // Keep only entries safe to show; null if none.
  function normalise(json) {
    if (!json || !Array.isArray(json.releases)) return null;
    var seen = Object.create(null);
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
        status: r.stage === "release" && VERDICTS.indexOf(r.status) >= 0 ? r.status : "untested",
        title: typeof r.title === "string" ? r.title : r.family + " " + r.version,
        summary: summary(r.summary),
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

  // The preview bundle embeds data/*.json as data-seed.
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
  function getJson(url, early) {
    return (early || loadJson(url)).then(function (json) {
      var data = normalise(json);
      if (!data) throw new Error("no releases in " + url);
      return data;
    });
  }
  // The config loads once, before the first data.
  var ready = null;
  function loadConfig() {
    if (!ready) {
      ready = loadJson(CONFIG).then(function (json) {
        if (json && Array.isArray(json.families) && Array.isArray(json.vendors)) config = json;
      }, function () { /* the pages still work without it, see knownFamily */ });
    }
    return ready;
  }
  // The owner's descriptions (/data/notes.json), laid over the releases as the Worker does, so
  // the bundled snapshot shows them too. Optional: a failed read just leaves the summaries as
  // they came. A note wins over a summary from the source.
  var notes = null;
  var notesReady = null;
  function loadNotes() {
    if (!notesReady) {
      notesReady = loadJson(NOTES).then(function (json) {
        if (json && json.notes && typeof json.notes === "object" && !Array.isArray(json.notes)) notes = json.notes;
      }, function () { /* no notes file: nothing to add */ });
    }
    return notesReady;
  }
  function joinNotes(data) {
    return loadNotes().then(function () {
      if (notes) data.releases.forEach(function (r) {
        if (Object.prototype.hasOwnProperty.call(notes, r.id) && summary(notes[r.id])) r.summary = summary(notes[r.id]);
      });
      return data;
    });
  }
  function refresh() {
    if (state.busy) return Promise.resolve();
    state.busy = true;
    // The snapshot is for a first load only; a failed poll keeps the data on screen.
    // Asked for at once with the config; only reading it waits.
    var early = loadJson(API);
    early.catch(function () {});
    loadNotes();
    return loadConfig().then(function () { return getJson(API, early); }).catch(function (err) {
      if (state.data) throw err;
      return getJson(SNAPSHOT);
    }).then(joinNotes).then(function (data) {
      var fresh = [];
      if (state.known) {
        fresh = data.releases.filter(function (r) { return !state.known[r.id]; });
      }
      state.known = state.known || {};
      data.releases.forEach(function (r) { state.known[r.id] = true; });
      state.data = data;
      state.failed = false;
      state.at = Date.now();
      note(data);
      if (fresh.length) announce(fresh);
      listeners.forEach(function (fn) { fn(data, fresh); });
    }, function () {
      state.failed = true;
      if (state.data) note(state.data, true);
      // Nothing to say and nothing ever will: give back the space the line keeps for itself.
      var line = document.getElementById("data-note");
      if (line && !state.data) line.classList.add("none");
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

  var dayFormat, relFormat;
  try {
    dayFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
  } catch (e) { /* older engines fall back to ISO text below */ }
  try { relFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" }); } catch (e) {}

  function day(t) { return dayFormat ? dayFormat.format(t) : new Date(t).toISOString().slice(0, 10); }
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
  // The release channel in a word, for a release with no build number.
  function channel(r) {
    var title = r.title || "";
    if (r.stage === "rc") return "Release candidate";
    if (r.stage === "beta") return /\bpreview\b/i.test(title) ? "Preview" : "Beta";
    if (r.stage === "release") return /\b(long[- ]term|lts)\b/i.test(title) ? "Long-term" : "Stable";
    return "Release";
  }
  // What a sigil is drawn from: the build, else a stable key.
  function sigilKey(r) {
    return r.build || r.family + " " + r.version + (r.stage === "release" ? "" : " " + r.stage + (r.beta || ""));
  }
  // "27.2 beta 3": version and stage, no OS name.
  function short(r) {
    return r.version + (r.stage === "release" ? "" : " " + stageLabel(r).toLowerCase());
  }
  var NUM = /^\d+([.H]\d+)*$/;
  // Higher version (date if not numeric), then stage, iteration, date.
  function better(a, b) {
    return ((NUM.test(a.version) && NUM.test(b.version) ? compareVersions(a.version, b.version) : a.t - b.t) ||
      (RANK[a.stage] - RANK[b.stage]) || ((a.beta || 0) - (b.beta || 0)) || (a.t - b.t)) > 0;
  }
  function latest(list, family, publicOnly) {
    var best = null;
    list.forEach(function (r) {
      if (r.family === family && (!publicOnly || r.stage === "release") && (!best || better(r, best))) best = r;
    });
    return best;
  }
  // A card's headline: the newest stable release (else any stage) and a higher beta or RC.
  function lead(list, family) {
    var main = latest(list, family, true) || latest(list, family, false);
    var any = main && latest(list, family, false);
    var pre = any && any.stage !== "release" && main.stage === "release" &&
      (NUM.test(any.version) && NUM.test(main.version) ?
        compareVersions(any.version, main.version) > 0 : any.t > main.t) ? any : null;
    return { main: main, pre: pre };
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

  var toastBack = null, toastHover = false, toastWired = null;
  function toastHeld(box) { return toastHover || box.contains(document.activeElement); }
  function armToast(box) {
    window.clearTimeout(toastTimer);
    if (!toastHeld(box)) toastTimer = window.setTimeout(hideToast, 12000);
  }
  function wireToast(box) {
    if (toastWired === box) return;
    toastWired = box;
    box.addEventListener("focusin", function (e) {
      window.clearTimeout(toastTimer);
      // Where focus came from is where Dismiss should send it back to.
      if (e.relatedTarget && !box.contains(e.relatedTarget)) toastBack = e.relatedTarget;
    });
    box.addEventListener("focusout", function (e) {
      if (!e.relatedTarget || !box.contains(e.relatedTarget)) {
        window.setTimeout(function () { if (box.classList.contains("on")) armToast(box); }, 0);
      }
    });
    box.addEventListener("pointerenter", function () {
      toastHover = true;
      window.clearTimeout(toastTimer);
    });
    box.addEventListener("pointerleave", function () {
      toastHover = false;
      if (box.classList.contains("on")) armToast(box);
    });
  }

  // The one freshness line (#data-note on a page): when the data was checked, or that the
  // live source is down and this is the saved copy (or, after a failed poll, the last load).
  // Its space is reserved in CSS.
  function note(data, failed) {
    var el = document.getElementById("data-note");
    if (!el) return;
    var saved = data.stale || data.snapshot;
    var old = !!(saved || failed);
    var t = data.fetchedAt;
    el.textContent = "";
    el.classList.remove("none");
    // old is a real boolean: toggle(name, undefined) ignores the force argument and flips the class.
    el.classList.toggle("old", old);
    if (old) {
      var what = saved ? "the saved copy" : "the last data";
      el.appendChild(document.createTextNode("Live source unavailable, showing " + what + (t ? (saved ? " from " : ", checked ") : ".")));
      if (t) {
        el.appendChild(saved ? h("time", null, day(t), { datetime: new Date(t).toISOString() }) : when(t));
        el.appendChild(document.createTextNode("."));
      }
    } else if (t) {
      el.appendChild(document.createTextNode("Data checked "));
      el.appendChild(when(t));
      el.appendChild(document.createTextNode("."));
    }
  }
  // "Now" for counting days: a stale or bundled copy is as of when it was fetched, so it does
  // not look more dormant every day.
  // A failed poll keeps Date.now(): the data on screen is the last good live load. Only a stale or
  // saved copy freezes time at its fetch.
  function clock() {
    var d = state.data;
    // Never earlier than the newest release it holds: one source may have fallen back to an old copy.
    return d && (d.stale || d.snapshot) && d.fetchedAt ? Math.max(d.fetchedAt, d.releases[0].t) : Date.now();
  }

  function announce(fresh) {
    var box = document.getElementById("toast");
    if (!box) return;
    wireToast(box);
    var shown = fresh.slice(0, 3);
    var p = h("p", "toast-text", "New: ");
    shown.forEach(function (r, i) {
      if (i) p.appendChild(document.createTextNode(", "));
      p.appendChild(h("a", "toast-link", r.title.replace(/ \(.*\)$/, ""), {
        href: "/timeline/?id=" + encodeURIComponent(r.id)
      }));
    });
    p.appendChild(document.createTextNode(
      (fresh.length > 3 ? " and " + (fresh.length - 3) + " more" : "") + "."));
    var wasOn = box.classList.contains("on");
    var active = document.activeElement;
    if (!wasOn || !toastBack) toastBack = active && !box.contains(active) ? active : null;
    var held = box.contains(active);
    box.textContent = "";
    box.appendChild(p);
    var close = h("button", "toast-close", "Dismiss", { type: "button" });
    close.addEventListener("click", hideToast);
    box.appendChild(close);
    // Rebuilding the toast must not drop the focus it held onto the page body.
    if (held) close.focus();
    box.classList.add("on");
    armToast(box);
  }
  function hideToast() {
    var box = document.getElementById("toast");
    window.clearTimeout(toastTimer);
    if (!box) return;
    if (box.contains(document.activeElement)) {
      var back = toastBack && toastBack !== document.body && document.contains(toastBack) ?
        toastBack : null;
      if (!back) {
        back = document.getElementById("content");
        if (back && !back.hasAttribute("tabindex")) {
          back.setAttribute("tabindex", "-1");
          back.addEventListener("blur", function () { back.removeAttribute("tabindex"); },
            { once: true });
        }
      }
      if (back) back.focus({ preventScroll: true });
    }
    toastBack = null;
    toastHover = false;
    box.classList.remove("on");
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
    vendors: function () { return config.vendors; },
    familyIds: familyIds, source: source, allowed: allowed, h: h, on: on, refresh: refresh, day: day,
    month: month, ago: ago, when: when, tick: tick, stageLabel: stageLabel, short: short,
    channel: channel, sigilKey: sigilKey, clock: clock,
    latest: latest, lead: lead, newer: newer, compareVersions: compareVersions,
    reduced: function () {
      return !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }
  };
  // Scroll reveals: below-fold .reveal elements get .pre, then .in.
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
