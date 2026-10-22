/* "Check my version" on the front page and Compare: a platform and a version or build, matched
   against the loaded releases. The answer is "current" (the newest public release by version, as
   the cards pick it), the newest of its line (the release's `line`: a RouterOS channel or a Windows
   feature update; else the major version), a
   pre-release, a version not in the data placed against its line, or how far behind the newest it
   is, counted as Compare counts, with the CVE count where window.Sec is loaded. The query is kept
   as ?platform= and ?build=. A second field lists the platform's known builds to pick from
   instead of typing. find, judge, behind and options are exported for the Node tests; the rest
   runs in a browser. */
(function (root) {
  "use strict";
  var DAY = 864e5;

  function norm(s) { return String(s == null ? "" : s).trim().replace(/\s+/g, " ").toLowerCase(); }

  // The series a dotted number belongs to: the major version; Windows has no such thing (22-26 are
  // years), so each feature update (25H2, 26H1) is its own.
  function seriesOf(r) { return r.family === "Windows" ? String(r.version) : String(r.major); }
  // A line is what the data says (`line`: a RouterOS channel, a Windows feature update), else the
  // series, which is what an older copy of the data without lines still gets.
  function lineOf(r) { return r.line ? String(r.line) : seriesOf(r); }

  function cmp(a, b) {
    var x = String(a).split("."), y = String(b).split(".");
    for (var i = 0; i < Math.max(x.length, y.length); i++) {
      var d = (parseInt(x[i], 10) || 0) - (parseInt(y[i], 10) || 0);
      if (d) return d;
    }
    return 0;
  }

  // For a dotted number that names no release (iOS "26.5", a Windows "26100.6584"): the release it
  // is older than, as { kind: "build" | "line", ref, line }, else null. A build is compared with
  // the newest build that starts with the same number; a version with the newest of its major version.
  function behind(list, text, family) {
    var asked = norm(text), prefix = norm(family) + " ";
    var rest = asked.indexOf(prefix) === 0 ? asked.slice(prefix.length) : asked;
    var t = rest.slice(rest.lastIndexOf(" ") + 1);
    if (!/^\d+(\.\d+)+$/.test(t)) return null;
    var seg = t.split(".")[0], best = null, pubs = list.filter(function (r) { return r.stage === "release"; });
    pubs.forEach(function (r) {
      if (r.build && r.build !== r.version && /^\d+(\.\d+)+$/.test(r.build) && r.build.split(".")[0] === seg &&
        (!best || cmp(r.build, best.build) > 0)) best = r;
    });
    if (best && cmp(t, best.build) < 0) return { kind: "build", ref: best };
    best = null;
    pubs.forEach(function (r) {
      if (seriesOf(r) === seg && (!best || cmp(r.version, best.version) > 0)) best = r;
    });
    if (best && cmp(t, best.version) < 0) return { kind: "line", ref: best, line: seg };
    return null;
  }

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
      hits = list.filter(function (r) { return seriesOf(r) === tries[i]; });
      if (hits.length && hits.every(function (r) { return r.version === hits[0].version; })) return pick(hits);
    }
    return null;
  }

  // Where `hit` stands against the newest public release (`ctx.newest` by version, as the cards
  // pick it; `ctx.higher(a, b)` orders versions; else the first public release and the list order,
  // which is newest first by date). kind: current, line (newest of its line), ahead,
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
    var lineTop = null;
    list.forEach(function (r) {
      if (r !== hit && r.stage === "release" && lineOf(r) === lineOf(hit) && higher(r, lineTop || hit)) lineTop = r;
    });
    return {
      kind: "superseded", hit: hit, newest: newest, between: between,
      lineNewest: lineTop && lineTop !== newest ? lineTop : null,
      pub: between.filter(function (r) { return r.stage === "release"; }).length,
      days: Math.round(Math.abs(Math.floor(newest.t / DAY) - Math.floor(hit.t / DAY)))
    };
  }

  // The choices for the "Pick a build" list: one per release of `family`, in the list order (newest
  // first), as { value, label }. The value is the build, else the version, which find() matches
  // either way; the label is the version, the build when it differs, and the stage of a release
  // that is not public ("27.2 · 24B5099f (beta)"). A value already offered is skipped.
  function options(list, family) {
    var seen = [], out = [];
    list.forEach(function (r) {
      if (r.family !== family) return;
      var value = String(r.build || r.version || "");
      if (!value || seen.indexOf(value) >= 0) return;
      seen.push(value);
      var label = String(r.version);
      if (r.build && String(r.build) !== label) label += " · " + r.build;
      if (r.stage && r.stage !== "release") label += " (" + r.stage + ")";
      out.push({ value: value, label: label });
    });
    return out;
  }

  var api = { find: find, judge: judge, behind: behind, options: options };
  if (typeof module === "object" && module.exports) { module.exports = api; return; }
  root.Lookup = api;

  var RO = root.RO, doc = root.document;
  var form = doc && doc.getElementById("lk-form");
  if (!RO || !form) return;
  var selFamily = doc.getElementById("lk-family");
  var input = doc.getElementById("lk-build");
  var pick = doc.getElementById("lk-pick");
  var out = doc.getElementById("lk-result");
  var all = [];
  var asked = false;
  var shown = null;
  var choices = [];
  var stale = false;
  var timer = null;

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
      var lead = box.querySelector(".sec-lead");
      if (lead) return lead.textContent + ": " + box.querySelector(".sec-count").textContent + ".";
      var say = box.querySelector(".sec-say");
      return say ? say.textContent + "." : "";
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
      var low = behind(list, text, family), ctx0 = context(list, family);
      if (low) {
        var again = ctx0.newest && low.ref !== ctx0.newest ? " The newest public release is " + name(ctx0.newest) + "." : "";
        return { rows: [["lk-say", "Not in the data, but older than " + (low.kind === "build"
          ? "the latest " + name(low.ref) + " build, " + low.ref.build + "."
          : name(low.ref) + ", the newest of " + family + " " + low.line + ".") + again]] };
      }
      var sample = list.filter(function (r) { return r.stage === "release"; })[0] || list[0];
      return { rows: [["lk-say", "Not found: no " + family + " release has the version or build “" + text.trim().slice(0, 64) +
        "”. Try a version such as " + sample.version + (sample.build ? " or a build such as " + sample.build : "") + "."]] };
    }
    var ctx = context(list, family);
    var j = judge(list, hit, ctx), k = j.kind, top = "The newest public release is " + (j.newest && name(j.newest)) + ".";
    var rows = [["lk-hit", name(hit) + (hit.build ? " · " + hit.build : "") + " · " + RO.day(hit.t)]];
    var say = k === "current" ? "Current for " + family + ": " + name(hit) + " is the newest public release."
      : k === "ahead" ? name(hit) + " is a pre-release, ahead of the newest public release, " + name(j.newest) + "."
      : k === "line" && family === "Windows" ? "Current for " + name(hit) + " servicing: " +
        (hit.build ? "build " + hit.build : name(hit)) + " is the latest of its version. " + top
      : k === "line" ? "Current for " + family + " " + RO.lineLabel(j.line) + ": " + name(hit) + " is the newest of its line. " + top
      : k === "older" ? name(hit) + " came out after " + name(j.newest) + " but is an older version. " + top
      : k === "superseded" ? "Superseded by " + name(j.newest) + " on " + RO.day(j.newest.t) + ": " +
        plural(j.pub, "public release") + " and " + plural(j.days, "day") + " behind." +
        (j.lineNewest ? " The newest of its line is " + name(j.lineNewest) + "." : "")
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

  // The "Pick a build" list for the selected platform: a first empty choice, then its builds. It
  // shows the release the input names (as find() reads it: a version, a prefixed name, any case),
  // else the empty choice, so a refill after a data poll keeps what was picked. After a platform
  // change the input text is stale, so the list stays empty until the visitor types or picks.
  function syncPick() {
    var now = "";
    if (!stale) {
      var hit = find(all.filter(function (r) { return r.family === selFamily.value; }), input.value, selFamily.value);
      var value = hit ? String(hit.build || hit.version || "") : "";
      choices.forEach(function (c) { if (c.value === value) now = c.value; });
    }
    pick.value = now;
  }
  function fillPick() {
    var next = options(all, selFamily.value);
    // A data poll with the same builds leaves the list alone, so an open list is not closed.
    if (pick.options.length && JSON.stringify(next) === JSON.stringify(choices)) { syncPick(); return; }
    choices = next;
    pick.textContent = "";
    pick.appendChild(RO.h("option", "", "Choose a build…", { value: "" }));
    choices.forEach(function (c) { pick.appendChild(RO.h("option", "", c.label, { value: c.value })); });
    syncPick();
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

  function cancel() {
    if (timer !== null) { root.clearTimeout(timer); timer = null; }
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    cancel();
    asked = true;
    stale = false;
    shown = null;
    show();
    remember();
    syncPick();
  });
  selFamily.addEventListener("change", function () {
    cancel();
    asked = false;
    stale = true;
    shown = null;
    out.textContent = "";
    fillPick();
    remember(true);
  });
  // Up and Down on a closed list fire change at every step, so the answer waits until the picking
  // stops; the input is filled at once.
  pick.addEventListener("change", function () {
    if (!pick.value) return;
    input.value = pick.value;
    stale = false;
    asked = true;
    cancel();
    timer = root.setTimeout(function () {
      timer = null;
      shown = null;
      show();
      remember();
    }, 300);
  });
  // Typing a version or build of the platform picks that release; anything else empties the pick.
  input.addEventListener("input", function () {
    stale = false;
    syncPick();
  });

  RO.on(function (data) {
    if (!data) return;
    all = data.releases;
    fillPick();
    form.hidden = false;
    doc.getElementById("lk-help").hidden = false;
    if (asked) show();
  });
  if (root.Sec) root.Sec.on(function () { if (asked) show(); });
})(typeof window !== "undefined" ? window : this);
