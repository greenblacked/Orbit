/* The Cadence view of the timeline: the last 12 months as one lane per platform, time running left
   to right and every release a mark placed to scale by its date. timeline.js loads this file the
   first time the view is shown and calls Lanes.draw(host, releases, opts) with the filtered list.
   Releases of one family on the same UTC day are ONE dot that holds them all (a count shows how
   many; its readout lists each). Each dot is a button of at least 44px; a lane is ONE tab stop
   (roving tabindex) and the arrow keys move inside it and between lanes. Activating a dot, or
   pointing at it, fills a readout under the board; the readout of an activated dot links to the
   source page and to the row in the list.
   Nothing here writes markup: text goes in with textContent, positions as custom properties. */
(function () {
  "use strict";
  var RO = window.RO;
  var DAY = 86400000;
  // Pixels per day: a month is about 150px, so a year is a few screens of board on a phone.
  var PX = 5;
  // The sticky family label on the left is 5.5rem wide (a custom property, so this file and the
  // style sheet cannot disagree at another root font size), and the axis starts LEAD px after it:
  // a dot at the very start of the window keeps its whole 44px button clear of the label.
  var LABEL_REM = 5.5;
  var LEAD = 24;
  // The room after Today for its own label.
  var TAIL = 64;
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  // Dots close in time stack in three rows of a lane, so that a busy week stays readable.
  var SLOTS = [0, -14, 14];
  var GAP = 16;
  var NOTE = "The last 12 months. Switch to List for older releases.";
  var HINT = "Select a release to see its details.";
  // The strongest stage of a day's releases is the one the mark shows.
  var RANK = { release: 3, rc: 2, beta: 1 };

  var S = null;

  function h(tag, cls, text, attrs) { return RO.h(tag, cls, text, attrs); }

  // Family order of the platform chips, then any family the config does not know.
  function order(releases) {
    var seen = {};
    releases.forEach(function (r) { seen[r.family] = true; });
    var known = RO.familyIds ? RO.familyIds() : [];
    var out = known.filter(function (f) { return seen[f]; });
    releases.forEach(function (r) { if (out.indexOf(r.family) < 0) out.push(r.family); });
    return out;
  }

  function label(r) {
    return r.family + " " + r.version + ", " + RO.stageLabel(r) + (r.build ? ", build " + r.build : "") + ", " + RO.day(r.t);
  }
  // A day's group: "iOS, 2 releases on May 11, 2026: 16.7.16 Release, 15.8.8 Release".
  function groupLabel(rs) {
    return rs[0].family + ", " + rs.length + " releases on " + RO.day(rs[0].t) + ": " + rs.map(function (r) {
      return r.version + " " + RO.stageLabel(r);
    }).join(", ");
  }
  function idsOf(d) { return d.rs.map(function (r) { return r.id; }); }
  // The dot that holds any of `ids` (a group that gained a member keeps its choice and focus).
  function find(ids) {
    for (var i = 0; ids && i < ids.length; i++) if (S.byId[ids[i]]) return S.byId[ids[i]];
    return null;
  }

  // The frame is built once: the board (scrolls sideways inside its own box), the readout and the
  // note. A draw replaces what is inside the board only, so the readout and the focus survive it.
  function frame(host) {
    host.textContent = "";
    var board = h("div", "lanes-board", null, { role: "group", "aria-label": "Releases of the last 12 months, one lane for each platform" });
    var read = h("div", "lanes-read", null, { id: "lanes-read", "aria-live": "polite" });
    host.appendChild(board);
    host.appendChild(read);
    host.appendChild(h("p", "small lanes-note", NOTE));
    S = { host: host, board: board, read: read, lanes: [], byId: {}, sel: null, cur: {}, peek: "" };
    board.addEventListener("click", function (e) {
      var d = dotOf(e.target);
      if (d) select(d);
    });
    board.addEventListener("keydown", keys);
    read.addEventListener("focusout", function () {
      setTimeout(function () {
        if (S.stale && !holding()) { S.stale = false; settle(); }
      }, 0);
    });
    board.addEventListener("focusin", function (e) {
      var d = dotOf(e.target);
      if (d) stop(d);
    });
    // Pointing previews the release; a touch has no hover, and its tap activates. A preview is
    // silent (the readout is only announced for a chosen dot), is drawn once per dot, and never
    // replaces the readout while focus is inside it: that would delete the link in focus.
    board.addEventListener("pointerover", function (e) {
      var d = e.pointerType === "touch" ? null : dotOf(e.target);
      if (!d || holding() || S.peek === d.r.id) return;
      S.peek = d.r.id;
      fill(d, false, false);
    });
    board.addEventListener("pointerout", function (e) {
      var d = e.pointerType === "touch" ? null : dotOf(e.target);
      if (!d || holding() || (e.relatedTarget && d.btn.contains(e.relatedTarget))) return;
      S.peek = "";
      settle();
    });
    settle();
  }

  function dotOf(el) {
    var btn = el && el.closest ? el.closest(".lanes-dot") : null;
    return btn && S ? S.byId[btn.getAttribute("data-id")] || null : null;
  }

  // Focus is on a link inside the readout: it must not be rebuilt under the visitor.
  function holding() {
    return S.read.contains(document.activeElement);
  }

  // The readout: family, version, stage, build and date, the summary, and (for a chosen dot) the
  // two links, once for every release the dot holds, newest first. A preview under the pointer has
  // no links, as it goes when the pointer leaves.
  function part(box, r, links, date) {
    var head = h("p", "lanes-r-t");
    head.appendChild(h("span", "lanes-r-fam", r.family));
    head.appendChild(h("span", "lanes-r-ver", r.version));
    var badge = h("span", "badge", null, { "data-kind": r.stage });
    badge.appendChild(h("span", "b-dot", null, { "aria-hidden": "true" }));
    badge.appendChild(h("span", "", RO.stageLabel(r)));
    head.appendChild(badge);
    if (r.build) head.appendChild(h("span", "build", r.build));
    box.appendChild(head);
    if (date) box.appendChild(h("p", "lanes-r-d", RO.day(r.t)));
    if (r.summary) box.appendChild(h("p", "lanes-r-s", r.summary));
    if (links) {
      var row = h("p", "lanes-r-a");
      var src = h("a", "lanes-link", "Source page", { href: r.url, target: "_blank", rel: "noopener noreferrer" });
      src.appendChild(h("span", "sr-only", " (opens in a new tab)"));
      row.appendChild(src);
      row.appendChild(h("a", "lanes-link", "Show in list", { href: "/timeline/?id=" + encodeURIComponent(r.id), "data-show": r.id }));
      box.appendChild(row);
    }
  }
  function fill(d, links, announce) {
    var read = S.read;
    read.setAttribute("aria-live", announce ? "polite" : "off");
    read.textContent = "";
    var box = h("div", "lanes-card fam-" + d.r.family.toLowerCase());
    if (d.rs.length === 1) part(box, d.r, links, true);
    else {
      box.appendChild(h("p", "lanes-r-d", d.rs.length + " releases on " + RO.day(d.r.t)));
      d.rs.forEach(function (r) {
        var one = h("div", "lanes-rel");
        part(one, r, links, false);
        box.appendChild(one);
      });
    }
    read.appendChild(box);
  }
  // The readout shows the chosen dot, or says how to choose one.
  function settle() {
    var d = find(S.sel);
    if (d) fill(d, true, false);
    else {
      S.read.textContent = "";
      S.read.appendChild(h("p", "lanes-hint", HINT));
    }
  }
  function select(d) {
    var was = find(S.sel);
    if (was) was.btn.classList.remove("is-sel");
    S.sel = idsOf(d);
    d.btn.classList.add("is-sel");
    S.peek = "";
    fill(d, true, true);
  }

  // The lane's one tab stop is the dot last focused or chosen in it (else its newest).
  function stop(d) {
    d.lane.dots.forEach(function (x) { x.btn.tabIndex = x === d ? 0 : -1; });
    S.cur[d.lane.family] = idsOf(d);
  }
  function go(d) {
    stop(d);
    d.btn.focus();
  }
  // The dot nearest in date to `t` in the nearest lane (above is -1, below is 1) that has dots.
  function across(d, way) {
    var i = S.lanes.indexOf(d.lane) + way;
    while (S.lanes[i] && !S.lanes[i].dots.length) i += way;
    var lane = S.lanes[i];
    if (!lane) return null;
    var best = null;
    lane.dots.forEach(function (x) {
      if (!best || Math.abs(x.t - d.t) < Math.abs(best.t - d.t)) best = x;
    });
    return best;
  }
  function keys(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    var d = dotOf(e.target);
    if (!d) return;
    var dots = d.lane.dots;
    var at = dots.indexOf(d);
    var next;
    if (e.key === "ArrowLeft") next = dots[at - 1];
    else if (e.key === "ArrowRight") next = dots[at + 1];
    else if (e.key === "Home") next = dots[0];
    else if (e.key === "End") next = dots[dots.length - 1];
    else if (e.key === "ArrowUp") next = across(d, -1);
    else if (e.key === "ArrowDown") next = across(d, 1);
    else return;
    e.preventDefault();
    if (next && next !== d) go(next);
  }

  function jump(board, left) {
    try { board.scrollTo({ left: left, behavior: "instant" }); } catch (e) { board.scrollLeft = left; }
  }

  // Draw the lanes for `releases` (the filtered list); returns how many fall in the 12 months.
  // opts.now is today (RO.clock(): a saved copy is as of when it was fetched), opts.fresh opens the
  // board scrolled to the newest end; otherwise the scroll, the tab stops, the chosen release and
  // a focused dot are kept as far as they still exist.
  function draw(host, releases, opts) {
    opts = opts || {};
    var now = typeof opts.now === "number" ? opts.now : Date.now();
    var fresh = !!opts.fresh;
    if (!S || S.host !== host || S.board.parentNode !== host) { frame(host); fresh = true; }
    var board = S.board;
    var d0 = new Date(now);
    var start = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() - 11, 1);
    var width = Math.round((now - start) / DAY * PX);
    var root = parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
    var labelPx = Math.round(LABEL_REM * root);
    function x(t) { return labelPx + LEAD + Math.round((Math.min(t, now) - start) / DAY * PX); }

    var active = document.activeElement;
    var held = active && board.contains(active) && active.closest ? dotOf(active) : null;
    var focusIds = held ? idsOf(held) : [];
    var kept = board.scrollLeft;

    var inner = h("div", "lanes-inner");
    inner.style.setProperty("--w", (labelPx + LEAD + width + TAIL) + "px");
    inner.style.setProperty("--label", labelPx + "px");
    var head = h("div", "lanes-head", null, { "aria-hidden": "true" });
    inner.appendChild(head);
    for (var m = 0; Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() - 11 + m, 1) <= now; m++) {
      var at = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() - 11 + m, 1));
      var left = x(at.getTime()) + "px";
      var tick = h("span", "lanes-tick", MONTHS[at.getUTCMonth()] + " " + at.getUTCFullYear());
      tick.style.setProperty("--x", left);
      head.appendChild(tick);
      var line = h("span", "lanes-gl", null, { "aria-hidden": "true" });
      line.style.setProperty("--x", left);
      inner.appendChild(line);
    }
    var today = h("div", "lanes-today", null, { "aria-hidden": "true" });
    today.style.setProperty("--x", x(now) + "px");
    today.appendChild(h("span", "", "Today"));
    inner.appendChild(today);

    S.lanes = [];
    S.byId = {};
    var shown = 0;
    order(releases).forEach(function (family) {
      var lane = { family: family, dots: [], el: h("div", "lanes-lane fam-" + family.toLowerCase(), null, { role: "group", "aria-label": family + " releases" }) };
      lane.el.appendChild(h("div", "lanes-label", family, { "aria-hidden": "true" }));
      var last = [-99, -99, -99];
      // One group for every UTC day: its releases newest first (the list's order breaks a tie).
      var days = {};
      var groups = [];
      releases.forEach(function (r, n) {
        if (r.family !== family || r.t < start || r.t > now + DAY) return;
        var u = new Date(r.t);
        var key = Date.UTC(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate());
        if (!days[key]) groups.push(days[key] = { key: key, t: r.t, rs: [] });
        if (r.t < days[key].t) days[key].t = r.t;
        days[key].rs.push({ r: r, n: n });
      });
      groups.sort(function (a, b) { return a.key - b.key; });
      groups.forEach(function (g) {
        g.rs.sort(function (a, b) { return (b.r.t - a.r.t) || (a.n - b.n); });
        var rs = g.rs.map(function (e) { return e.r; });
        var best = rs.reduce(function (a, b) { return (RANK[b.stage] || 0) > (RANK[a.stage] || 0) ? b : a; });
        var px = x(g.t);
        // The first row with room; in a crowd, the row whose last dot is farthest away.
        var slot = 0;
        var room = -1e9;
        for (var i = 0; i < SLOTS.length; i++) {
          if (px - last[i] >= GAP) { slot = i; room = 1e9; break; }
          if (px - last[i] > room) { room = px - last[i]; slot = i; }
        }
        last[slot] = px;
        var many = rs.length > 1;
        var btn = h("button", "lanes-dot", null, {
          type: "button", "aria-label": many ? groupLabel(rs) : label(rs[0]), "aria-controls": "lanes-read",
          "data-id": rs[0].id, "data-ids": rs.map(function (r) { return r.id; }).join(" "), tabindex: "-1"
        });
        btn.style.setProperty("--x", px + "px");
        btn.style.setProperty("--y", SLOTS[slot] + "px");
        btn.appendChild(h("span", "lanes-mark", null, { "data-kind": best.stage, "aria-hidden": "true" }));
        if (many) btn.appendChild(h("span", "lanes-n", String(rs.length), { "aria-hidden": "true" }));
        lane.el.appendChild(btn);
        var dot = { r: rs[0], rs: rs, t: g.t, btn: btn, lane: lane };
        lane.dots.push(dot);
        rs.forEach(function (r) { S.byId[r.id] = dot; });
        shown += rs.length;
      });
      if (lane.dots.length) {
        var pick = find(S.cur[family]);
        stop(pick && pick.lane === lane ? pick : lane.dots[lane.dots.length - 1]);
      } else {
        lane.el.appendChild(h("span", "lanes-none", "None in the last 12 months"));
      }
      inner.appendChild(lane.el);
      S.lanes.push(lane);
    });
    board.textContent = "";
    board.appendChild(inner);

    if (fresh) {
      var toEnd = function () { jump(board, board.scrollWidth); };
      toEnd();
      if (window.requestAnimationFrame) window.requestAnimationFrame(toEnd);
    } else jump(board, kept);
    var chosen = find(S.sel);
    var before = JSON.stringify(S.sel);
    if (chosen) chosen.btn.classList.add("is-sel");
    S.sel = chosen ? idsOf(chosen) : null;
    // A chosen dot that gained or lost a release shows its new list; with the focus on a link in
    // the readout that waits (S.stale) until the focus leaves it.
    if (chosen && JSON.stringify(S.sel) !== before && !fresh) {
      if (holding()) S.stale = true;
      else fill(chosen, true, false);
    }
    var back = find(focusIds);
    if (back) back.btn.focus({ preventScroll: true });
    if (!S.sel || fresh) settle();
    return shown;
  }

  window.Lanes = { draw: draw };
})();
