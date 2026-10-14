/* "Check my version" on the front page and Compare: a platform and a version or build, matched
   against the loaded releases. The answer is "current" (the newest public release by version, as
   the cards pick it), current for its major line, or how far behind the newest it is, counted as
   Compare counts, with the CVE count where window.Sec is loaded. The query is kept as ?platform=
   and ?build=. find and judge are exported for the Node tests; the rest runs in a browser. */
(function (root) {
  "use strict";
  var DAY = 864e5;

  function norm(s) { return String(s == null ? "" : s).trim().replace(/\s+/g, " ").toLowerCase(); }

  function lineOf(r) { return String(r.major); }

  // The release whose version or build is `text` (a release wins over a beta of the same version),
  // else null. A name may come first ("iOS 26.1", "macOS Tahoe 26.6.2"); a bare major ("Android
  // 16") works when its releases share one version.
  function find(list, text, family) {
    var asked = norm(text);
    if (!asked) return null;
    var tries = [asked], name = norm(family) + " ", rest = asked;
    if (asked.indexOf(name) === 0) tries.push(rest = asked.slice(name.length));
    tries.push(rest.slice(rest.lastIndexOf(" ") + 1));
    function pick(hits) {
      for (var n = 0; n < hits.length; n++) if (hits[n].stage === "release") return hits[n];
      return hits[0];
    }
    var i, hits;
    for (i = 0; i < tries.length; i++) {
      hits = list.filter(function (r) { return norm(r.build) === tries[i] || norm(r.version) === tries[i]; });
      if (hits.length) return pick(hits);
    }
    for (i = 0; i < tries.length; i++) {
      if (!/^\d+$/.test(tries[i])) continue;
      hits = list.filter(function (r) { return lineOf(r) === tries[i]; });
      if (hits.length && hits.every(function (r) { return r.version === hits[0].version; })) return pick(hits);
    }
    return null;
  }

  // Where `hit` stands against the newest public release (`ctx.newest` by version, as the cards
  // pick it; `ctx.higher(a, b)` orders versions; else the first public release and the list order,
  // which is newest first by date). kind: current, line (newest of its major line), ahead,
  // older (dated after the newest, lower version), superseded (public releases between by list
  // position and days apart, as Compare counts them) or none.
  function judge(list, hit, ctx) {
    ctx = ctx || {};
    var at = list.indexOf(hit), newest = ctx.newest || null;
    if (!newest) for (var i = 0; i < list.length; i++) if (list[i].stage === "release") { newest = list[i]; break; }
    var top = newest ? list.indexOf(newest) : -1;
    if (at < 0 || top < 0) return { kind: "none" };
    var higher = ctx.higher || function (a, b) { return list.indexOf(a) < list.indexOf(b); };
    if (hit === newest) return { kind: "current", hit: hit, newest: newest };
    var between = at > top ? list.slice(top + 1, at) : [];
    if (hit.stage !== "release") {
      if (higher(hit, newest)) return { kind: "ahead", hit: hit, newest: newest };
    } else if (!list.some(function (r) {
      return r !== hit && r.stage === "release" && lineOf(r) === lineOf(hit) && higher(r, hit);
    })) {
      var res = { kind: "line", hit: hit, newest: newest, line: lineOf(hit) };
      if (at > top) res.between = between;
      return res;
    }
    if (at < top) return { kind: "older", hit: hit, newest: newest };
    return {
      kind: "superseded", hit: hit, newest: newest, between: between,
      pub: between.filter(function (r) { return r.stage === "release"; }).length,
      days: Math.round(Math.abs(Math.floor(newest.t / DAY) - Math.floor(hit.t / DAY)))
    };
  }

  var api = { find: find, judge: judge };
  if (typeof module === "object" && module.exports) { module.exports = api; return; }
  root.Lookup = api;

  var RO = root.RO, doc = root.document;
  var form = doc && doc.getElementById("lk-form");
  if (!RO || !form) return;
  var selFamily = doc.getElementById("lk-family");
  var input = doc.getElementById("lk-build");
  var out = doc.getElementById("lk-result");
  var all = [];
  var asked = false;
  var shown = null;

  try {
    var params = new URLSearchParams(root.location.search);
    var offered = Array.prototype.map.call(selFamily.options, function (o) { return o.value; });
    var wanted = params.get("platform") || params.get("family");
    if (offered.indexOf(wanted) >= 0) selFamily.value = wanted;
    var typed = params.get("build");
    if (typed && typed.trim()) { input.value = typed.slice(0, 64); asked = true; }
  } catch (e) { /* an empty form */ }

  function name(r) { return r.family + " " + RO.short(r); }
  function plural(n, one) { return n + " " + one + (n === 1 ? "" : "s"); }

  // The CVE sentence from Compare's security section, or "" without it.
  function cves(j) {
    if (!root.Sec || !j.between || (j.kind !== "superseded" && j.kind !== "line")) return "";
    try {
      var box = root.Sec.compare(j.newest, j.hit, j.between, name);
      return box.querySelector(".sec-lead").textContent + ": " + box.querySelector(".sec-count").textContent + ".";
    } catch (e) { return ""; }
  }

  // The newest public release by version, as the cards pick it, and the version order.
  function context(list, family) {
    var main = RO.lead(list, family).main;
    return {
      newest: main && main.stage === "release" ? main : null,
      higher: function (a, b) { return RO.compareVersions(a.version, b.version) > 0 || a.version === b.version && a.t > b.t; }
    };
  }

  // The rows to draw as [class, text], and the Compare link when there is a range.
  function answer(family, text) {
    var list = all.filter(function (r) { return r.family === family; });
    if (!norm(text)) return { rows: [["lk-say", "Enter a version or a build number."]] };
    if (!list.length) return { rows: [["lk-say", "No " + family + " releases in the data."]] };
    var hit = find(list, text, family);
    if (!hit) {
      var sample = list.filter(function (r) { return r.stage === "release"; })[0] || list[0];
      return { rows: [["lk-say", "Not found: no " + family + " release has the version or build “" + text.trim().slice(0, 64) +
        "”. Try a version such as " + sample.version + (sample.build ? " or a build such as " + sample.build : "") + "."]] };
    }
    var j = judge(list, hit, context(list, family)), k = j.kind, top = "The newest public release is " + (j.newest && name(j.newest)) + ".";
    var rows = [["lk-hit", name(hit) + (hit.build ? " · " + hit.build : "") + " · " + RO.day(hit.t)]];
    var say = k === "current" ? "Current for " + family + ": " + name(hit) + " is the newest public release."
      : k === "ahead" ? name(hit) + " is a pre-release, ahead of the newest public release, " + name(j.newest) + "."
      : k === "line" ? "Current for " + family + " " + j.line + ": " + name(hit) + " is the newest of its line. " + top
      : k === "older" ? name(hit) + " came out after " + name(j.newest) + " but is an older version. " + top
      : k === "superseded" ? "Superseded by " + name(j.newest) + " on " + RO.day(j.newest.t) + ": " +
        plural(j.pub, "public release") + " and " + plural(j.days, "day") + " behind."
      : "Cannot place " + name(hit) + " against the newest public release.";
    rows.push(["lk-say", say]);
    var more = cves(j);
    if (more) rows.push(["lk-cve", more]);
    var link = j.between ? {
      text: "Compare " + name(hit) + " with " + name(j.newest),
      href: "/compare/?family=" + encodeURIComponent(family) + "&from=" + encodeURIComponent(hit.id) + "&to=" +
        encodeURIComponent(j.newest.id) + "&platform=" + encodeURIComponent(family) + "&build=" +
        encodeURIComponent(hit.build || hit.version)
    } : null;
    return { rows: rows, link: link };
  }

  // A data poll must not re-announce the same answer; Check clears `shown`, so it always redraws.
  function show() {
    if (!all.length) return;
    var result = answer(selFamily.value, input.value);
    var key = JSON.stringify(result);
    if (key === shown) return;
    shown = key;
    out.textContent = "";
    result.rows.forEach(function (row) { out.appendChild(RO.h("p", row[0], row[1])); });
    if (result.link) {
      var p = RO.h("p", "lk-link");
      p.appendChild(RO.h("a", "lk-compare", result.link.text, { href: result.link.href }));
      out.appendChild(p);
    }
  }

  function remember(clear) {
    var keep = root.location.search.replace(/^\?/, "").split("&").filter(function (pair) {
      return pair && !/^(platform|build)(=|$)/.test(pair);
    });
    var text = clear ? "" : input.value.trim();
    if (text) keep.push("platform=" + encodeURIComponent(selFamily.value), "build=" + encodeURIComponent(text));
    try {
      root.history.replaceState(null, "", root.location.pathname + (keep.length ? "?" + keep.join("&") : "") + root.location.hash);
    } catch (e) { /* no shareable address */ }
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    asked = true;
    shown = null;
    show();
    remember();
  });
  selFamily.addEventListener("change", function () {
    asked = false;
    shown = null;
    out.textContent = "";
    remember(true);
  });

  RO.on(function (data) {
    if (!data) return;
    all = data.releases;
    form.hidden = false;
    doc.getElementById("lk-help").hidden = false;
    if (asked) show();
  });
  if (root.Sec) root.Sec.on(function () { if (asked) show(); });
})(typeof window !== "undefined" ? window : this);
