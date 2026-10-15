/* The timeline page: every release newest first, grouped by month, filtered by platform and stage
   with two groups of toggle buttons, and by line (?line=long-term) for a platform that keeps several
   supported lines at once. The filters live in the query string (?family=iOS&stage=beta),
   so a filtered view can be linked to. Only the newest PAGE months of the filtered list are drawn;
   "Show older" adds the next PAGE, so a long history does not build thousands of rows at once.
   The list is the default view. "Cadence" (?view=cadence) is the same filtered releases as lanes
   over the last 12 months; lanes.js draws it and loads only when it is first asked for. */
(function () {
  "use strict";
  var RO = window.RO;
  var filters = document.getElementById("filters");
  var count = document.getElementById("count");
  var host = document.getElementById("timeline");
  var moreWrap = document.getElementById("tl-more");
  var more = document.getElementById("more");
  var lanes = document.getElementById("lanes");
  var viewChips = document.getElementById("chips-view");
  // Month sections drawn per step. A month is a section that has releases, so a gap in the data
  // never makes an empty step, and one step is a bounded amount of markup.
  var PAGE = 12;
  var NOUNS = {
    all: ["release", "releases"],
    release: ["public release", "public releases"],
    beta: ["beta", "betas"],
    rc: ["release candidate", "release candidates"]
  };
  var state = { family: "all", stage: "all", line: "all", view: "list" };
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var lineChips = document.getElementById("chips-line");
  var lineBox = document.getElementById("filter-line");
  var releases = [];
  var rows = [];
  var list = [];
  var groups = [];
  var drawn = 0;
  var limit = PAGE;
  var signature = "";
  var target = "";
  // Cadence: the filtered ids last drawn (a poll that changes none of them redraws nothing), how
  // many releases fall in its 12 months (null until drawn), and whether the next draw is the
  // first of a visit to the view (it opens scrolled to today).
  var lanesSig = "";
  var inWindow = null;
  var freshLanes = false;

  // The values a group of chips offers: a query string can only pick one of those.
  function offered(group) {
    var chips = document.querySelectorAll("#" + group + " .chip");
    return Array.prototype.map.call(chips, function (chip) { return chip.getAttribute("data-v"); });
  }

  (function fromQuery() {
    try {
      var q = new URLSearchParams(window.location.search);
      if (offered("chips-family").indexOf(q.get("family")) >= 0) state.family = q.get("family");
      if (offered("chips-stage").indexOf(q.get("stage")) >= 0) state.stage = q.get("stage");
      // The line chips follow the data, so the address is checked against them once it loads.
      if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/.test(q.get("line") || "")) state.line = q.get("line");
      target = (q.get("id") || "").slice(0, 300);
      // A link to one release is a link to its row, so ?id= always means the list.
      if (q.get("view") === "cadence" && !target) state.view = "cadence";
    } catch (e) { /* no query support: show everything */ }
  })();

  function matches(r) {
    return (state.family === "all" || r.family === state.family) && (state.stage === "all" || r.stage === state.stage) &&
      (state.line === "all" || r.line === state.line);
  }

  // The lines of the chosen platform, public ones first (the headlined line, then by version) and
  // then any with only pre-releases (RouterOS testing). None for "All" or a platform with no lines.
  function linesOf() {
    if (state.family === "all") return [];
    var names = RO.lead(releases, state.family).lines.map(function (x) { return x.line; });
    releases.forEach(function (r) {
      if (r.family === state.family && r.line && names.indexOf(r.line) < 0) names.push(r.line);
    });
    return names;
  }
  // Redraw the line chips for the chosen platform and drop a line it does not have.
  var lineKey = "";
  function syncLines() {
    var names = linesOf();
    if (names.indexOf(state.line) < 0) {
      var dropped = state.line !== "all";
      state.line = "all";
      if (dropped && !target) remember();
    }
    // A poll that changes no line must not rebuild the chips: that would drop their focus.
    var key = names.join("|");
    if (key === lineKey) { press("chips-line", state.line); return; }
    lineKey = key;
    lineBox.hidden = !names.length;
    lineChips.textContent = "";
    if (!names.length) return;
    ["all"].concat(names).forEach(function (name) {
      lineChips.appendChild(RO.h("button", "chip", name === "all" ? "All" : RO.lineLabel(name),
        { type: "button", "aria-pressed": String(name === state.line), "data-v": name }));
    });
  }

  // "05 Oct": the year is in the month header above, and a fixed width keeps the column straight.
  function shortDay(t) {
    var d = new Date(t);
    return (d.getUTCDate() < 10 ? "0" : "") + d.getUTCDate() + " " + MONTHS[d.getUTCMonth()];
  }

  // A row of the git-log graph: a release sits on the trunk, a beta or release candidate branches
  // one column to the right. The dot's shape (filled, ring, diamond) says the stage as well as its
  // colour does, and the text badge stays.
  function item(r) {
    var li = RO.h("li", "tl-item fam-" + r.family.toLowerCase() + " st-" + r.stage +
      (r.stage === "release" ? " tl-trunk" : " tl-branch") + (r.summary ? " has-note" : ""), null, { "data-id": r.id });
    rows.push({ li: li, r: r });
    var a = RO.h("a", "tl-link", null, { href: r.url, target: "_blank", rel: "noopener noreferrer" });
    a.appendChild(RO.h("span", "tl-dot", null, { "aria-hidden": "true" }));
    a.appendChild(RO.h("span", "tl-day", shortDay(r.t)));
    a.appendChild(RO.h("span", "tl-fam", r.family));
    a.appendChild(RO.h("span", "tl-ver", r.version));
    var badge = RO.h("span", "badge", null, { "data-kind": r.stage });
    badge.appendChild(RO.h("span", "b-dot", null, { "aria-hidden": "true" }));
    badge.appendChild(RO.h("span", "", RO.stageLabel(r)));
    a.appendChild(badge);
    if (r.build) a.appendChild(RO.h("span", "build", r.build));
    a.appendChild(RO.h("span", "sr-only", " (opens the release page in a new tab)"));
    li.appendChild(a);
    // The description: inline after the version on a wide screen, a line under the row on a
    // narrow one (CSS); clamped to two lines by .tl-note-t either way.
    if (r.summary) {
      var d = RO.h("p", "tl-note");
      d.appendChild(RO.h("span", "tl-note-t", r.summary));
      li.appendChild(d);
    }
    note(li, r);
    return li;
  }

  function hrefOf(el) {
    var a = el.querySelector("a");
    return a ? a.getAttribute("href") : "";
  }
  // The security note under a row, when security.json has an entry for the release. The notes
  // arrive after the list, so they are added to the rows already on the page.
  function note(li, r) {
    var old = li.querySelector(".sec");
    var chip = null;
    try { chip = window.Sec ? window.Sec.chip(r) : null; } catch (e) { chip = null; }
    // Keep the line (and the focus on its link) when it would be rebuilt the same.
    if (old && chip && old.className === chip.className && old.textContent === chip.textContent &&
        hrefOf(old) === hrefOf(chip)) return;
    if (old) li.removeChild(old);
    li.classList.remove("has-sec");
    if (!chip) return;
    li.appendChild(chip);
    li.classList.add("has-sec");
  }
  if (window.Sec) window.Sec.on(function () { rows.forEach(function (row) { note(row.li, row.r); }); });

  // The filtered list as month sections, newest first: { m: "October 2026", items: [release] }.
  function byMonth(items) {
    var out = [];
    items.forEach(function (r) {
      var m = RO.month(r.t);
      if (!out.length || out[out.length - 1].m !== m) out.push({ m: m, items: [] });
      out[out.length - 1].items.push(r);
    });
    return out;
  }
  function noun(n) { return NOUNS[state.stage][n === 1 ? 0 : 1]; }

  // The sticky bar of a month: its name (the h2), how many releases it has, and a small bar whose
  // width (--d, 0 to 1) is that count against the busiest month drawn. The bar is decoration.
  function monthBar(g) {
    var bar = RO.h("div", "month-bar");
    bar.appendChild(RO.h("h2", "month-h", g.m));
    bar.appendChild(RO.h("span", "month-n", g.items.length + (g.items.length === 1 ? " release" : " releases")));
    bar.appendChild(RO.h("span", "month-dens", null, { "aria-hidden": "true" }));
    return bar;
  }
  // Show older can bring a busier month, so every bar is measured again against the drawn peak.
  function density() {
    var peak = 1;
    groups.slice(0, drawn).forEach(function (g) { if (g.items.length > peak) peak = g.items.length; });
    var bars = host.querySelectorAll(".month-dens");
    for (var i = 0; i < bars.length; i++) {
      bars[i].style.setProperty("--d", (groups[i].items.length / peak).toFixed(3));
    }
  }

  // Draw sections [from, to) after the ones already there.
  function draw(from, to) {
    groups.slice(from, to).forEach(function (g) {
      var sec = RO.h("section", "month");
      sec.appendChild(monthBar(g));
      var ul = RO.h("ul", "tl");
      g.items.forEach(function (r) { ul.appendChild(item(r)); });
      sec.appendChild(ul);
      host.appendChild(sec);
    });
    drawn = Math.min(groups.length, to);
    density();
  }
  function button() {
    var left = list.length - rows.length;
    moreWrap.hidden = left <= 0;
    if (left > 0) more.textContent = "Show older (" + left + " more " + noun(left) + ")";
  }

  // The count line, the same filtered total in both views. In Cadence it also says how many of
  // them the 12 months hold, once the lanes have drawn.
  function paintCount() {
    var which = state.family === "all" ? "" : state.family + " " + (state.line === "all" ? "" : state.line + " ");
    var n = list.length;
    if (!n) count.textContent = "No " + which + NOUNS[state.stage][1] + " in the data.";
    else if (state.view !== "cadence" || inWindow === null) count.textContent = n + " " + which + noun(n);
    else if (!inWindow) count.textContent = "No " + which + NOUNS[state.stage][1] + " in the last 12 months (" + n + " in all)";
    else count.textContent = inWindow + " " + which + noun(inWindow) + " in the last 12 months" +
      (inWindow === n ? "" : " (" + n + " in all)");
  }

  // Redraw from the filtered list; `limit` sections stay open, so a poll that brings a release
  // does not fold what the visitor opened, and a filter change resets it.
  function render() {
    list = releases.filter(matches);
    groups = byMonth(list);
    if (state.view === "cadence") {
      renderLanes();
      paintCount();
      return;
    }
    host.textContent = "";
    rows = [];
    draw(0, limit);
    button();
    paintCount();
  }

  // Cadence: lanes.js is fetched the first time the view is shown, never from the page. A failed
  // load leaves a sentence and the List button, which needs no script of its own.
  var lanesLoad = "idle";
  var lanesWaiting = null;
  function lanesNote(text) {
    lanes.textContent = "";
    lanes.appendChild(RO.h("p", "notice", text));
  }
  function whenLanes(go) {
    if (window.Lanes) { go(); return; }
    // The preview bundle runs lanes.js right after this script and cannot fetch it.
    if (lanesLoad === "failed" || document.querySelector("script[data-seed]")) {
      lanesNote("The Cadence view could not load. Switch to List to read the releases.");
      return;
    }
    lanesWaiting = go;
    lanesNote("Loading the Cadence view…");
    if (lanesLoad === "loading") return;
    lanesLoad = "loading";
    var s = document.createElement("script");
    s.src = "/assets/lanes.js";
    s.onload = function () {
      lanesLoad = window.Lanes ? "ready" : "failed";
      var go2 = lanesWaiting;
      lanesWaiting = null;
      if (go2 && window.Lanes) go2();
      else if (state.view === "cadence") lanesNote("The Cadence view could not load. Switch to List to read the releases.");
    };
    s.onerror = function () {
      lanesLoad = "failed";
      lanesWaiting = null;
      if (state.view === "cadence") lanesNote("The Cadence view could not load. Switch to List to read the releases.");
    };
    document.head.appendChild(s);
  }
  function renderLanes() {
    var sig = list.map(function (r) { return r.id; }).join("|");
    // A poll that changes none of the filtered releases redraws nothing, so a focused dot stays.
    if (!freshLanes && sig === lanesSig && window.Lanes) return;
    whenLanes(function () {
      if (state.view !== "cadence") return;
      var fresh = freshLanes;
      freshLanes = false;
      lanesSig = sig;
      inWindow = window.Lanes.draw(lanes, list, { now: RO.clock(), fresh: fresh });
      paintCount();
    });
  }

  // List or Cadence: one of the two hosts shows, and the one that does not is emptied (the list)
  // or kept (the lanes, which would only cost a redraw).
  function showView() {
    var cadence = state.view === "cadence";
    host.hidden = cadence;
    lanes.hidden = !cadence;
    if (cadence) {
      moreWrap.hidden = true;
      host.textContent = "";
      rows = [];
      drawn = 0;
      freshLanes = true;
    } else {
      inWindow = null;
    }
    press("chips-view", state.view);
  }

  // The next step of older months, added below the open ones; the focus goes to the first new
  // row, as the button may be gone once nothing older is left.
  function older() {
    var first = rows.length;
    limit = drawn + PAGE;
    draw(drawn, limit);
    button();
    var link = rows[first] && rows[first].li.querySelector("a");
    if (link) link.focus();
    else if (!moreWrap.hidden) more.focus();
  }
  more.addEventListener("click", older);

  function press(group, value) {
    var chips = document.querySelectorAll("#" + group + " .chip");
    for (var i = 0; i < chips.length; i++) {
      chips[i].setAttribute("aria-pressed", String(chips[i].getAttribute("data-v") === value));
    }
  }
  function remember() {
    var q = [];
    if (state.family !== "all") q.push("family=" + encodeURIComponent(state.family));
    if (state.stage !== "all") q.push("stage=" + encodeURIComponent(state.stage));
    if (state.line !== "all") q.push("line=" + encodeURIComponent(state.line));
    if (state.view === "cadence") q.push("view=cadence");
    try {
      window.history.replaceState(null, "", window.location.pathname + (q.length ? "?" + q.join("&") : ""));
    } catch (e) { /* the filters still work without a shareable address */ }
  }
  function choose(key, group) {
    return function (event) {
      var chip = event.target.closest ? event.target.closest(".chip") : null;
      if (!chip) return;
      state[key] = chip.getAttribute("data-v");
      limit = PAGE;
      if (key === "family") { state.line = "all"; syncLines(); }
      press(group, state[key]);
      remember();
      render();
    };
  }
  document.getElementById("chips-family").addEventListener("click", choose("family", "chips-family"));
  document.getElementById("chips-stage").addEventListener("click", choose("stage", "chips-stage"));
  lineChips.addEventListener("click", choose("line", "chips-line"));
  viewChips.addEventListener("click", function (event) {
    var chip = event.target.closest ? event.target.closest(".chip") : null;
    if (!chip) return;
    var next = chip.getAttribute("data-v") === "cadence" ? "cadence" : "list";
    if (next === state.view) return;
    state.view = next;
    showView();
    remember();
    if (releases.length) render();
  });
  press("chips-family", state.family);
  press("chips-stage", state.stage);
  showView();

  // A link with ?id= (the toast's) lands on that row, whatever the filters hide and however far
  // back it is: the months down to it are opened, in whole steps.
  function reveal() {
    var rel = releases.filter(function (r) { return r.id === target; })[0];
    if (!rel) { target = ""; remember(); return; }
    if (!matches(rel)) {
      state.family = "all";
      state.stage = "all";
      state.line = "all";
      syncLines();
      press("chips-family", "all");
      press("chips-stage", "all");
      limit = PAGE;
      remember();
      render();
    }
    var at = 0;
    groups.forEach(function (g, n) { if (g.items.indexOf(rel) >= 0) at = n; });
    if (at >= drawn) {
      limit = Math.ceil((at + 1) / PAGE) * PAGE;
      render();
    }
    var row = rows.filter(function (x) { return x.r.id === target; })[0];
    target = "";
    remember();
    var link = row && row.li.querySelector("a");
    if (!link) return;
    row.li.scrollIntoView({ block: "center" });
    link.focus();
  }

  RO.on(function (data, fresh, failed) {
    if (!data) {
      count.textContent = "Could not load releases. The source is linked below.";
      return;
    }
    filters.hidden = false;
    // A poll that brings nothing new must not rebuild the list: that would drop the focus
    // from a link the visitor tabbed to.
    var next = data.releases.map(function (r) { return r.id; }).join("|");
    if (next === signature) return;
    signature = next;
    // Keep the oldest month the visitor opened open, wherever it sits after the new data.
    var edge = drawn > 0 ? groups[drawn - 1].m : "";
    var held = document.activeElement === more;
    var focusedId = "";
    var focusedAt = -1;
    rows.forEach(function (x, n) { if (x.li.contains(document.activeElement)) { focusedId = x.r.id; focusedAt = n; } });
    releases = data.releases;
    syncLines();
    // Only when the visitor opened more than the default view: the default stays the newest PAGE months.
    if (edge && limit > PAGE) {
      byMonth(releases.filter(matches)).forEach(function (g, n) {
        if (g.m === edge && n + 1 > limit) limit = n + 1;
      });
    }
    render();
    if (held && moreWrap.hidden && rows.length) {
      var last = rows[rows.length - 1].li.querySelector("a");
      if (last) last.focus();
    }
    if (focusedId) {
      var kept = rows.filter(function (x) { return x.r.id === focusedId; })[0];
      var keptLink = kept && kept.li.querySelector("a");
      if (keptLink) keptLink.focus();
      else if (focusedAt >= rows.length && !moreWrap.hidden) more.focus();
      else if (rows.length) {
        // The row is no longer drawn (a newer month pushed it out of the default view): the focus
        // goes to the row now at its place, else the last one, never to the body.
        var near = rows[Math.min(focusedAt, rows.length - 1)].li.querySelector("a");
        if (near) near.focus();
      }
    }
    if (target) reveal();
  });
})();
