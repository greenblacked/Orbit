/* The compare page: one platform, two of its releases, and what lies between them (builds, dates,
   calendar days, how many betas and release candidates, and the list). Releases are ordered
   newest first, so "in between" is every entry of that platform strictly between the two picks. */
(function () {
  "use strict";
  var RO = window.RO;
  var form = document.getElementById("cmp-form");
  var selFamily = document.getElementById("c-family");
  var selFrom = document.getElementById("c-from");
  var selTo = document.getElementById("c-to");
  var out = document.getElementById("cmp-result");
  var all = [];
  var list = [];
  // null until the first data arrives, so an empty platform still renders once.
  var signature = null;

  try {
    var wanted = new URLSearchParams(window.location.search).get("family");
    var offered = Array.prototype.map.call(selFamily.options, function (o) { return o.value; });
    if (offered.indexOf(wanted) >= 0) selFamily.value = wanted;
  } catch (e) { /* the default platform stays */ }

  function label(r) {
    return RO.short(r) + (r.build ? " · " + r.build : "") + " · " + RO.day(r.t);
  }
  function fill(select, keep, fallback) {
    select.textContent = "";
    list.forEach(function (r) { select.appendChild(RO.h("option", "", label(r), { value: r.id })); });
    var has = list.some(function (r) { return r.id === keep; });
    select.value = has ? keep : fallback;
  }
  function days(a, b) { return Math.round(Math.abs(Math.floor(a / 864e5) - Math.floor(b / 864e5))); }

  function card(title, r) {
    var box = RO.h("div", "cmp-card fam-" + r.family.toLowerCase());
    box.appendChild(RO.h("p", "f-label", title));
    box.appendChild(RO.h("p", "cmp-ver", r.family + " " + RO.short(r)));
    box.appendChild(RO.h("p", "build", r.build ? "Build " + r.build : "No build number"));
    box.appendChild(RO.h("p", "small", RO.day(r.t)));
    var a = RO.h("a", "rel-apple", "View release", { href: r.url, target: "_blank", rel: "noopener noreferrer" });
    a.appendChild(RO.h("span", "sr-only", " (opens in a new tab)"));
    box.appendChild(a);
    return box;
  }
  function stat(value, name) {
    var d = RO.h("div", "stat");
    d.appendChild(RO.h("dt", "stat-k", name));
    d.appendChild(RO.h("dd", "stat-v", String(value)));
    return d;
  }

  function render() {
    out.textContent = "";
    var i = list.map(function (r) { return r.id; }).indexOf(selFrom.value);
    var j = list.map(function (r) { return r.id; }).indexOf(selTo.value);
    if (i < 0 || j < 0) { out.appendChild(RO.h("p", "small", "No releases for this platform in the data.")); return; }
    if (list.length === 1) {
      out.appendChild(RO.h("p", "notice", "Only one " + list[0].family + " release in the data so far."));
      out.appendChild(card("Release", list[0]));
      return;
    }
    if (i === j) {
      out.appendChild(RO.h("p", "notice", "Pick two different releases to compare."));
      out.appendChild(card("Release", list[i]));
      return;
    }
    var newerAt = Math.min(i, j), olderAt = Math.max(i, j);
    var newer = list[newerAt], older = list[olderAt];
    var between = list.slice(newerAt + 1, olderAt);
    var pre = between.filter(function (r) { return r.stage !== "release"; }).length;
    var span = newer.t - older.t;

    var cards = RO.h("div", "cmp-cards");
    cards.appendChild(card("Older", older));
    cards.appendChild(card("Newer", newer));
    out.appendChild(cards);

    var dl = RO.h("dl", "stats");
    dl.appendChild(stat(days(newer.t, older.t), days(newer.t, older.t) === 1 ? "day between" : "days between"));
    dl.appendChild(stat(pre, pre === 1 ? "beta or RC in between" : "betas and RCs in between"));
    var pub = between.length - pre;
    dl.appendChild(stat(pub, pub === 1 ? "public release in between" : "public releases in between"));
    out.appendChild(dl);
    // The oldest pick is the oldest entry of the data: say where the data begins, so a count
    // of what lies in between is not read as the whole history.
    if (olderAt === list.length - 1) {
      out.appendChild(RO.h("p", "small data-range", "History in this data starts " + RO.day(older.t) + "."));
    }

    var track = RO.h("div", "track-line", null, { "aria-hidden": "true" });
    [older].concat(between, [newer]).forEach(function (r, n, arr) {
      var dot = RO.h("span", "pin");
      var x = span > 0 ? ((r.t - older.t) / span) * 100 : (n / (arr.length - 1)) * 100;
      dot.style.setProperty("--x", x + "%");
      if (r === older || r === newer) dot.className = "pin end";
      else if (r.stage !== "release") dot.className = "pin pre";
      track.appendChild(dot);
    });
    out.appendChild(track);

    out.appendChild(RO.h("h2", "month-h", "In between"));
    if (!between.length) { out.appendChild(RO.h("p", "small", "Nothing was published between these two.")); return; }
    var ol = RO.h("ol", "tl");
    between.forEach(function (r) {
      var li = RO.h("li");
      var a = RO.h("a", "tl-link fam-" + r.family.toLowerCase(), null, { href: r.url, target: "_blank", rel: "noopener noreferrer" });
      a.appendChild(RO.h("span", "tl-day", RO.day(r.t)));
      a.appendChild(RO.h("span", "tl-ver", RO.short(r)));
      a.appendChild(RO.h("span", "build", r.build));
      a.appendChild(RO.h("span", "sr-only", " (opens the release page in a new tab)"));
      li.appendChild(a);
      ol.appendChild(li);
    });
    out.appendChild(ol);
  }

  // A useful first comparison: the newest entry against the newest public release of its own
  // line (same major), else the newest earlier public release, else the oldest entry.
  function defaultFrom() {
    if (list.length < 2) return list.length ? list[0].id : "";
    var line = list[0].major, any = "";
    for (var n = 1; n < list.length; n++) {
      if (list[n].stage !== "release") continue;
      if (list[n].major === line) return list[n].id;
      if (!any) any = list[n].id;
    }
    return any || list[list.length - 1].id;
  }

  function pick(reset) {
    list = all.filter(function (r) { return r.family === selFamily.value; });
    var keepFrom = reset ? "" : selFrom.value, keepTo = reset ? "" : selTo.value;
    var newest = list.length ? list[0].id : "";
    signature = list.map(function (r) { return r.id; }).join("|");
    fill(selFrom, keepFrom, defaultFrom());
    fill(selTo, keepTo, newest);
    render();
  }
  selFamily.addEventListener("change", function () { pick(true); });
  selFrom.addEventListener("change", render);
  selTo.addEventListener("change", render);

  RO.on(function (data) {
    if (!data) { out.textContent = "Could not load releases. The source is linked below."; return; }
    form.hidden = false;
    all = data.releases;
    // Rebuild the pickers only when this platform's releases changed: a poll with nothing new must
    // not empty a select the visitor has open, or re-announce the result.
    var next = all.filter(function (r) { return r.family === selFamily.value; })
      .map(function (r) { return r.id; }).join("|");
    if (next === signature && out.firstChild) return;
    pick(false);
  });
})();
