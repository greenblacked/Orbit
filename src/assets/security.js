/* Security notes for the timeline and compare pages (docs/adr/0008). Asks /api/security.json
   once and falls back to the bundled /data/security.json only if that fails; a failure of both
   leaves the pages as they are. The file holds ids, titles, dates and links only, so
   the wording here is ours: "listed in" or "fixed after ... up to ...", never "fixed in" or
   "newly fixed". Elements are built with textContent, and a link is used only if it is an
   https address. Nothing here runs on the
   front page. window.Sec = { on, chip, compare }. */
(function () {
  "use strict";
  var RO = window.RO;
  var SNAPSHOT = "/data/security.json";
  var API = "/api/security.json";
  var DAY = 864e5;
  var GRACE = 14 * DAY;
  var STALE = 30 * DAY;
  var CAP = 20;
  var STATUSES = ["listed", "linked", "no-cve-entries", "not-found", "not-applicable", "unavailable", "not-connected"];
  var CVE = /^CVE-\d{4}-\d{4,}$/;
  var payload = null;
  var listeners = [];
  var vendors = Object.create(null);

  function own(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
  function plain(v) { return !!v && typeof v === "object" && !Array.isArray(v); }
  function link(url) {
    try {
      var u = new URL(url);
      return u.protocol === "https:" && u.hostname !== "" && !u.username && !u.password ? u.href : "";
    } catch (e) { return ""; }
  }

  // Take a payload only if it has the schema-1 shape and is not older than the one in hand.
  function accept(json) {
    if (!plain(json) || json.schema !== 1 || !plain(json.sources) || !plain(json.notes) || !plain(json.releases)) return false;
    var made = Date.parse(json.generatedAt);
    if (isNaN(made)) return false;
    if (payload && made <= Date.parse(payload.generatedAt)) return false;
    payload = json;
    return true;
  }
  // A listener that throws must not stop the others or leave the caller's state half set.
  function notify() { listeners.forEach(function (fn) { try { fn(); } catch (e) { /* skip */ } }); }
  // A vendor's name from the families config (already cached by releases.js); its id otherwise.
  function vendorName(id) { return own(vendors, id) ? vendors[id] : String(id); }
  function named() {
    return RO.ready().then(function () {
      RO.vendors().forEach(function (v) {
        if (plain(v) && typeof v.id === "string" && typeof v.name === "string") vendors[v.id] = v.name;
      });
    }, function () {});
  }
  function on(fn) { listeners.push(fn); }

  // One request: the API, then the static snapshot only if the API fails. The bundled preview
  // embeds the snapshot and cannot fetch, so it reads that alone.
  var embedded = !!document.querySelector("script[data-seed]");
  var loaded = (embedded ? RO.loadJson(SNAPSHOT) : RO.loadJson(API)).catch(function () { return RO.loadJson(SNAPSHOT); })
    .then(function (json) { return accept(json); }, function () { return false; });
  Promise.all([named(), loaded]).then(function (done) { if (done[1]) notify(); });

  // One release's entry, kept only if it has the shape the contract gives its status.
  function read(id) {
    if (!payload || !own(payload.releases, id)) return null;
    var e = payload.releases[id];
    if (!plain(e) || STATUSES.indexOf(e.status) < 0 || !Array.isArray(e.notes) || !Array.isArray(e.cves)) return null;
    var notes = e.notes.filter(function (u) { return own(payload.notes, u) && link(u) && plain(payload.notes[u]); });
    var cves = e.cves.filter(function (c) { return typeof c === "string" && CVE.test(c); });
    if (notes.length !== e.notes.length || cves.length !== e.cves.length) return null;
    // listed and linked need a note; no-cve-entries may or may not name one; the rest name none.
    if (e.status === "listed" || e.status === "linked" ? !notes.length : e.status !== "no-cve-entries" && notes.length) return null;
    if (e.status === "listed" ? !cves.length || e.count !== cves.length : cves.length) return null;
    if (e.status === "no-cve-entries" ? e.count !== 0 : e.status !== "listed" && e.count !== null) return null;
    return {
      status: e.status, notes: notes, cves: cves, count: e.count,
      source: typeof e.source === "string" && own(payload.sources, e.source) ? e.source : "",
      patchLevel: typeof e.patchLevel === "string" && /^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(e.patchLevel) ? e.patchLevel : "",
      checkedAt: Date.parse(e.checkedAt)
    };
  }
  // A failed source, or a check older than 30 days, means the row is not trustworthy now.
  function stale(e) {
    if (e.status === "not-applicable" || e.status === "not-connected") return false;
    var origin = e.source ? payload.sources[e.source] : null;
    if (plain(origin) && origin.status === "failed") return true;
    for (var i = 0; i < e.notes.length; i++) {
      var src = payload.sources[payload.notes[e.notes[i]].source];
      if (plain(src) && src.status === "failed") return true;
    }
    return isNaN(e.checkedAt) || Date.now() - e.checkedAt > STALE;
  }
  function checked(e) {
    return RO.day(isNaN(e.checkedAt) ? Date.parse(payload.generatedAt) : e.checkedAt);
  }

  // What a timeline row says, or null for nothing: { tone, text, href }.
  function describe(r) {
    var e = read(r.id);
    if (!e || e.status === "not-applicable") return null;
    var vendor = vendorName(r.vendor);
    var android = r.family === "Android";
    var first = e.notes[0] || "";
    var say = function (tone, text, href) { return { tone: tone, text: text, href: href || "" }; };
    if (stale(e)) {
      return say("unavailable", "Could not refresh security data (snapshot " + RO.day(Date.parse(payload.generatedAt)) + ")");
    }
    switch (e.status) {
      case "listed":
        return say("listed", e.count + (e.count === 1 ? " CVE" : " CVEs") + " listed in " + vendor + " notes", first);
      case "linked":
        return say("linked", vendor + " security notes for this build (CVEs not counted)", first);
      case "no-cve-entries":
        return say("none", android ? "Bulletin lists no CVEs" : vendor + " lists no CVE entries for this build", first);
      case "not-found":
        if (android && !e.patchLevel) return say("missing", "No patch level published for this build");
        return say("missing", Date.now() - r.t < GRACE
          ? "Security notes not published yet (checked " + checked(e) + ")"
          : "No matching security note found (checked " + checked(e) + ")");
      case "not-connected":
        return say("unavailable", "Security details not connected for " + r.family + " yet",
          RO.allowed(r.vendor, RO.source(r.vendor).url) ? RO.source(r.vendor).url : "");
      default:
        return say("unavailable", android && e.patchLevel
          ? "No Android Security Bulletin read for " + e.patchLevel.slice(0, 7) + " yet"
          : "Could not refresh security data (snapshot " + RO.day(Date.parse(payload.generatedAt)) + ")");
    }
  }

  function anchor(text, href) {
    var a = RO.h("a", "sec-link", text, { href: href, target: "_blank", rel: "noopener noreferrer" });
    a.appendChild(RO.h("span", "sr-only", " (opens in a new tab)"));
    return a;
  }
  // The note under a timeline row: a link when a note exists, else plain text.
  function chip(r) {
    var v = describe(r);
    if (!v) return null;
    var p = RO.h("p", "sec sec-" + v.tone);
    p.appendChild(v.href ? anchor(v.text, v.href) : RO.h("span", "sec-text", v.text));
    return p;
  }

  // --- compare ---------------------------------------------------------------------------

  function name(r) { return r.family + " " + RO.short(r); }
  function month(note, url) {
    var m = /(\d{4})-(0[1-9]|1[0-2])/.exec(String(note.title || "")) || /(\d{4})-(0[1-9]|1[0-2])/.exec(url);
    return m ? m[1] + "-" + m[2] : "";
  }
  function nextMonth(m) {
    var y = Number(m.slice(0, 4)), n = Number(m.slice(5)) + 1;
    if (n > 12) { y += 1; n = 1; }
    return ("000" + y).slice(-4) + "-" + (n < 10 ? "0" : "") + n;
  }
  // Android: the bulletins of the months after the older patch level up to the newer one.
  function bulletins(newer, older) {
    var sources = Object.create(null);
    newer.notes.concat(older.notes).forEach(function (u) { sources[payload.notes[u].source] = true; });
    var found = Object.create(null), missing = [], urls = [];
    Object.keys(payload.notes).forEach(function (u) {
      if (!plain(payload.notes[u]) || !sources[payload.notes[u].source] || !link(u)) return;
      var m = month(payload.notes[u], u);
      found[m] = (found[m] || []).concat(u);
    });
    var last = newer.patchLevel.slice(0, 7);
    for (var m = nextMonth(older.patchLevel.slice(0, 7)); m <= last; m = nextMonth(m)) {
      if (found[m]) urls = urls.concat(found[m]); else missing.push(m);
    }
    return { urls: urls, missing: missing };
  }
  function severities(urls) {
    var map = Object.create(null);
    urls.forEach(function (u) {
      (Array.isArray(payload.notes[u].cves) ? payload.notes[u].cves : []).forEach(function (c) {
        if (plain(c) && typeof c.id === "string" && typeof c.severity === "string" && c.severity && !map[c.id]) map[c.id] = c.severity;
      });
    });
    return map;
  }
  function cveItem(id, severity) {
    var li = RO.h("li", "cve");
    li.appendChild(RO.h("span", "cve-id", id));
    if (severity) {
      var cls = severity.toLowerCase().replace(/[^a-z]/g, "");
      li.appendChild(RO.h("span", "sev sev-" + cls, severity));
    }
    return li;
  }

  // The security section of Compare for two releases of one family, or null for nothing.
  // `between` is Compare's in-between list: its public releases count toward a non-Android range.
  function compare(newer, older, between) {
    if (!payload || newer.family !== older.family) return null;
    var en = read(newer.id), eo = read(older.id);
    if (!en && !eo) return null;
    var android = newer.family === "Android";
    var mids = android ? [] : (Array.isArray(between) ? between : []).filter(function (r) {
      return plain(r) && r.stage === "release" && r.family === newer.family;
    }).map(function (r) { return [r, read(r.id)]; });
    var box = RO.h("section", "sec-cmp");
    box.appendChild(RO.h("h2", "month-h", "Security notes"));
    var say = function (text) { box.appendChild(RO.h("p", "small sec-say", text)); return box; };
    var sides = [[newer, en], [older, eo]];
    var counted = sides.concat(mids);
    var names = function (pick, from) {
      return (from || sides).filter(function (s) { return pick(s[1]); }).map(function (s) { return name(s[0]); }).join(" and ");
    };
    var unknown = names(function (e) {
      return !e || stale(e) || ["listed", "linked", "no-cve-entries"].indexOf(e.status) < 0;
    }, counted);
    if (unknown) return say("Security comparison unavailable: no known note for " + unknown);
    var linked = names(function (e) { return e.status === "linked"; }, counted);
    if (linked) return say("Cannot compare: CVEs not counted for " + linked);

    var urls = en.notes, seen = Object.create(null), ids;
    eo.cves.forEach(function (c) { seen[c] = true; });
    if (newer.family === "Android") {
      var absent = names(function (e) { return !e.patchLevel; });
      if (absent) return say("Security comparison unavailable: no patch level for " + absent);
      if (en.patchLevel <= eo.patchLevel) return say("Patch level is not newer; no CVEs listed beyond " + name(older) + "'s");
      var from = eo.patchLevel.slice(0, 7);
      if (from === en.patchLevel.slice(0, 7) || eo.patchLevel.slice(8) === "01") {
        return say("Security comparison unavailable: bulletins are read by month, so the parts of " + from + " after the older patch level are not told apart");
      }
      var range = bulletins(en, eo);
      if (range.missing.length) return say("Security comparison unavailable: no bulletin read for " + range.missing.slice(0, 3).join(", ") + (range.missing.length > 3 ? " and " + (range.missing.length - 3) + " more" : ""));
      urls = range.urls;
      var union = Object.create(null);
      urls.forEach(function (u) { (Array.isArray(payload.notes[u].cves) ? payload.notes[u].cves : []).forEach(function (c) {
          if (plain(c) && typeof c.id === "string" && CVE.test(c.id)) union[c.id] = true;
        }); });
      ids = Object.keys(union).sort();
    } else {
      // Every release after the older one, up to the newer: Apple's notes list one release each.
      var all = Object.create(null);
      mids.concat([[newer, en]]).forEach(function (s) {
        s[1].cves.forEach(function (c) { all[c] = true; });
        s[1].notes.forEach(function (u) { if (urls.indexOf(u) < 0) urls = urls.concat(u); });
      });
      ids = Object.keys(all).sort();
    }
    ids = ids.filter(function (c) { return !seen[c]; });

    box.appendChild(RO.h("p", "sec-lead", android
      ? "Listed in " + name(newer) + "'s notes, not in " + name(older) + "'s"
      : "Fixed after " + name(older) + ", up to " + name(newer)));
    box.appendChild(RO.h("p", "sec-count", ids.length ? ids.length + (ids.length === 1 ? " CVE" : " CVEs") : "No CVEs"));
    if (ids.length) {
      var sev = severities(urls);
      var ul = RO.h("ul", "cve-list");
      ids.slice(0, CAP).forEach(function (id) { ul.appendChild(cveItem(id, sev[id])); });
      box.appendChild(ul);
      if (ids.length > CAP) box.appendChild(RO.h("p", "small", "and " + (ids.length - CAP) + " more"));
      var bare = ids.filter(function (id) { return !sev[id]; }).length;
      if (bare) box.appendChild(RO.h("p", "small", "Severity not published for " + bare + " of " + ids.length + "."));
    }
    var links = RO.h("p", "sec-links");
    // Both picks, then every release in between whose note adds a CVE to the list above.
    var shown = Object.create(null), seenUrl = Object.create(null);
    ids.forEach(function (id) { shown[id] = true; });
    var adds = function (s) { return s[1].cves.some(function (c) { return shown[c]; }); };
    sides.slice(0, 1).concat(mids.filter(adds), sides.slice(1)).forEach(function (s) {
      var u = s[1].notes[0];
      if (!u || seenUrl[u]) return;
      seenUrl[u] = true;
      links.appendChild(anchor(name(s[0]) + " notes", u));
    });
    if (links.firstChild) box.appendChild(links);
    return box;
  }

  window.Sec = { on: on, chip: chip, compare: compare };
})();
