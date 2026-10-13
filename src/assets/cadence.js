/* Cadence pulse: per platform family, the median gap between its releases and the days since
   its last one (counted from when the data was fetched, if it is a saved copy), as a quiet row under the dial and as a slow breathing of the family's ring.
   The breath's period is the median gap scaled down: half a second per day, between 2 and 14
   seconds (CSS reads it from --breath; it is off under reduced motion). Both follow the time
   machine: the numbers are as of the chosen day. The page loads this file once it has painted (home.js). Gaps count distinct UTC days, so a beta and
   a release candidate on one day are one release day. */
(function () {
  "use strict";
  var RO = window.RO;
  var row = document.getElementById("cadence");
  if (!RO || !row) return;
  var DAY = 86400000;
  var SECONDS_PER_DAY = 0.5, MIN_PERIOD = 2, MAX_PERIOD = 14;
  var all = [], asOf = null;

  function median(values) {
    var v = values.slice().sort(function (a, b) { return a - b; });
    var mid = v.length >> 1;
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  }
  // Release days of a family up to a time, oldest first, one per UTC day.
  function days(list, family, at) {
    var seen = {}, out = [];
    list.forEach(function (r) {
      var d = Math.floor(r.t / DAY);
      if (r.family !== family || r.t > at || seen[d]) return;
      seen[d] = true;
      out.push(d);
    });
    return out.sort(function (a, b) { return a - b; });
  }
  // { count, median (days, or null with fewer than two release days), since (days, or null) }.
  function stats(list, family, at) {
    var d = days(list, family, at), gaps = [];
    for (var i = 1; i < d.length; i++) gaps.push(d[i] - d[i - 1]);
    return {
      count: d.length,
      median: gaps.length ? median(gaps) : null,
      since: d.length ? Math.max(0, Math.floor(at / DAY) - d[d.length - 1]) : null
    };
  }
  function period(medianDays) {
    return Math.min(MAX_PERIOD, Math.max(MIN_PERIOD, medianDays * SECONDS_PER_DAY));
  }
  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }
  function families() {
    var list = RO.families();
    if (list.length) return list;
    var seen = {};
    return all.filter(function (r) { return !seen[r.family] && (seen[r.family] = true); })
      .map(function (r) { return { id: r.family, name: r.family }; });
  }

  function paint() {
    var at = asOf === null ? RO.clock() : asOf;
    var next = document.createDocumentFragment();
    families().forEach(function (fam) {
      var s = stats(all, fam.id, at);
      var li = RO.h("li", "fam-" + String(fam.id).toLowerCase());
      li.appendChild(RO.h("span", "c-fam", fam.name || fam.id));
      var parts = ["No releases yet"];
      if (s.count === 1) parts = ["1 release,", plural(s.since, "day") + " ago"];
      else if (s.count > 1) parts = ["Every " + plural(Math.round(s.median), "day") + ",", "last " + plural(s.since, "day") + " ago"];
      // Each part is one unbreakable unit (CSS), so a narrow column wraps only between them.
      var nums = RO.h("span", "c-nums");
      parts.forEach(function (part, i) {
        if (i) nums.appendChild(document.createTextNode(" "));
        nums.appendChild(RO.h("span", "c-part", part));
      });
      li.appendChild(nums);
      next.appendChild(li);
      // Compared, not put into a selector: an id may hold a quote or a backslash.
      var ring = Array.prototype.filter.call(document.querySelectorAll(".ring"), function (n) {
        return n.getAttribute("data-family") === fam.id;
      })[0];
      if (!ring) return;
      if (s.median === null) {
        ring.classList.remove("breath");
        ring.style.removeProperty("--breath");
      } else {
        ring.style.setProperty("--breath", period(s.median).toFixed(2) + "s");
        ring.classList.add("breath");
      }
    });
    // The same text again (a poll that found nothing new) leaves the row alone.
    if (row.textContent !== next.textContent || !row.firstChild) {
      row.textContent = "";
      row.appendChild(next);
    }
  }

  function at(t) {
    asOf = typeof t === "number" ? t : null;
    paint();
  }
  document.addEventListener("ro:asof", function (e) { at(e.detail && e.detail.t); });
  // Loaded after the first paint, so the page hands over the day the hand points at (at).
  window.Cadence = { at: at };
  // The dial draws its rings after the data arrives, and again when it changes.
  document.addEventListener("ro:orbit", paint);
  RO.on(function (data, fresh, failed) {
    if (!data) {
      // Nothing to show: give back the space the row keeps for itself.
      if (failed) row.classList.add("none");
      return;
    }
    row.classList.remove("none");
    all = data.releases;
    paint();
  });
})();
