/* "Check my version" on the front page and Compare: one platform and a version or a build, matched
   against the release data the page already loaded (releases.js). The answer is either "current"
   or how far behind the newest public release it is, counted the way Compare counts (public
   releases strictly between, calendar days apart), with the CVE count from the security notes (window.Sec) where
   that page has it. The query lives in the address as ?platform= and ?build=. The matching is
   plain functions, exported for the Node tests; the page part runs only in a browser. */
(function (root) {
  "use strict";
  var DAY = 864e5;

  function norm(s) { return String(s === undefined || s === null ? "" : s).trim().replace(/\s+/g, " ").toLowerCase(); }

  // The release of `list` (one platform, newest first) whose version or build is `text`, else
  // null. A version shared by a beta and the release goes to the release. "iOS 26.1" works too.
  function find(list, text, family) {
    var asked = norm(text);
    if (!asked) return null;
    var tries = [asked], name = norm(family);
    if (name && asked.indexOf(name + " ") === 0) tries.push(asked.slice(name.length + 1));
    for (var i = 0; i < tries.length; i++) {
      var hits = list.filter(function (r) { return norm(r.build) === tries[i] || norm(r.version) === tries[i]; });
      if (!hits.length) continue;
      for (var n = 0; n < hits.length; n++) if (hits[n].stage === "release") return hits[n];
      return hits[0];
    }
    return null;
  }

  // Where `hit` stands against the newest public release of its platform. `list` is newest first.
  // kind: "current", "ahead" (a beta or RC newer than that release) or "superseded", with the
  // public releases and the days between, as Compare counts them; "none" if it cannot tell.
  function judge(list, hit) {
    var at = list.indexOf(hit), top = -1;
    for (var i = 0; i < list.length; i++) if (list[i].stage === "release") { top = i; break; }
    if (at < 0 || top < 0) return { kind: "none" };
    var newest = list[top];
    if (at === top) return { kind: "current", hit: hit, newest: newest };
    if (at < top) return { kind: "ahead", hit: hit, newest: newest };
    var between = list.slice(top + 1, at);
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

  // A restored query: ?platform= (else the Compare page's ?family=) and ?build=.
  try {
    var params = new URLSearchParams(root.location.search);
    var offered = Array.prototype.map.call(selFamily.options, function (o) { return o.value; });
    var wanted = params.get("platform") || params.get("family");
    if (offered.indexOf(wanted) >= 0) selFamily.value = wanted;
    var typed = params.get("build");
    if (typed && typed.trim()) { input.value = typed.slice(0, 64); asked = true; }
  } catch (e) { /* an empty form */ }

  function name(r) { return r.family + " " + RO.short(r); }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  function line(cls, text) { return RO.h("p", cls, text); }

  // The CVE sentence from the security section of Compare, or "" when that page has none loaded.
  function cves(j) {
    if (!root.Sec || j.kind !== "superseded") return "";
    var section = null;
    try { section = root.Sec.compare(j.newest, j.hit, j.between, name); } catch (e) { return ""; }
    var lead = section && section.querySelector(".sec-lead");
    var count = section && section.querySelector(".sec-count");
    return lead && count ? lead.textContent + ": " + count.textContent + "." : "";
  }

  // What to say: a list of [class, text] and, for a comparison, the link.
  function answer(family, text) {
    var list = all.filter(function (r) { return r.family === family; });
    if (!norm(text)) return { rows: [["lk-say", "Enter a version or a build number."]] };
    if (!list.length) return { rows: [["lk-say", "No " + family + " releases in the data."]] };
    var hit = find(list, text, family);
    if (!hit) {
      var sample = list.filter(function (r) { return r.stage === "release"; })[0] || list[0];
      var tip = "a version such as " + sample.version + (sample.build ? " or a build such as " + sample.build : "");
      return { rows: [["lk-say", "Not found: no " + family + " release in the data has the version or build “" +
        text.trim().slice(0, 64) + "”. Try " + tip + "."]] };
    }
    var j = judge(list, hit);
    var rows = [["lk-hit", name(hit) + (hit.build ? " · " + hit.build : "") + " · " + RO.day(hit.t)]];
    var link = null;
    if (j.kind === "current") {
      rows.push(["lk-say", "Current for " + family + ": " + name(hit) + " is the newest public release."]);
    } else if (j.kind === "ahead") {
      rows.push(["lk-say", name(hit) + " is a pre-release, ahead of the newest public release, " + name(j.newest) + "."]);
    } else if (j.kind === "superseded") {
      rows.push(["lk-say", "Superseded by " + name(j.newest) + " on " + RO.day(j.newest.t) + ": " +
        plural(j.pub, "public release", "public releases") + " and " + plural(j.days, "day", "days") + " behind."]);
      var more = cves(j);
      if (more) rows.push(["lk-cve", more]);
      link = {
        text: "Compare " + name(hit) + " with " + name(j.newest),
        href: "/compare/?family=" + encodeURIComponent(family) + "&from=" + encodeURIComponent(hit.id) +
          "&to=" + encodeURIComponent(j.newest.id)
      };
    } else {
      rows.push(["lk-say", "Could not tell how " + name(hit) + " compares with the newest public release."]);
    }
    return { rows: rows, link: link };
  }

  // Redrawn only when the words change, so a data poll does not re-announce the same answer.
  function show() {
    if (!all.length) return;
    var result = answer(selFamily.value, input.value);
    var key = JSON.stringify(result);
    if (key === shown) return;
    shown = key;
    out.textContent = "";
    result.rows.forEach(function (row) { out.appendChild(line(row[0], row[1])); });
    if (result.link) {
      var p = RO.h("p", "lk-link");
      p.appendChild(RO.h("a", "lk-compare", result.link.text, { href: result.link.href }));
      out.appendChild(p);
    }
  }

  // Keep ?platform= and ?build= in the address, and any other query (Compare's) as it is.
  function remember() {
    var keep = root.location.search.replace(/^\?/, "").split("&").filter(function (pair) {
      return pair && !/^(platform|build)(=|$)/.test(pair);
    });
    var text = input.value.trim();
    if (text) keep.push("platform=" + encodeURIComponent(selFamily.value), "build=" + encodeURIComponent(text));
    try {
      root.history.replaceState(null, "", root.location.pathname + (keep.length ? "?" + keep.join("&") : "") + root.location.hash);
    } catch (e) { /* the answer still shows without a shareable address */ }
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    asked = true;
    show();
    remember();
  });
  // A new platform makes the old answer stale; it is asked for again with Check.
  selFamily.addEventListener("change", function () {
    asked = false;
    shown = null;
    out.textContent = "";
  });

  RO.on(function (data) {
    if (!data) return;
    all = data.releases;
    form.hidden = false;
    if (asked) show();
  });
  if (root.Sec) root.Sec.on(function () { if (asked) show(); });
})(typeof window !== "undefined" ? window : this);
