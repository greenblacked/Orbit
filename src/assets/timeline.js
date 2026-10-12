/* The timeline page: every release newest first, grouped by month, filtered by platform and stage
   with two groups of toggle buttons. The filters live in the query string (?family=iOS&stage=beta),
   so a filtered view can be linked to. */
(function () {
  "use strict";
  var RO = window.RO;
  var filters = document.getElementById("filters");
  var count = document.getElementById("count");
  var host = document.getElementById("timeline");
  var NOUNS = {
    all: ["release", "releases"],
    release: ["public release", "public releases"],
    beta: ["beta", "betas"],
    rc: ["release candidate", "release candidates"]
  };
  var state = { family: "all", stage: "all" };
  var releases = [];
  var signature = "";

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
    } catch (e) { /* no query support: show everything */ }
  })();

  function matches(r) {
    return (state.family === "all" || r.family === state.family) && (state.stage === "all" || r.stage === state.stage);
  }

  function item(r) {
    var li = RO.h("li", "tl-item fam-" + r.family.toLowerCase());
    var a = RO.h("a", "tl-link", null, { href: r.url, target: "_blank", rel: "noopener noreferrer" });
    a.appendChild(RO.h("span", "tl-day", RO.day(r.t)));
    a.appendChild(RO.h("span", "tl-fam", r.family));
    a.appendChild(RO.h("span", "tl-ver", r.version));
    var badge = RO.h("span", "badge", null, { "data-kind": r.stage });
    badge.appendChild(RO.h("span", "b-dot", null, { "aria-hidden": "true" }));
    badge.appendChild(RO.h("span", "", RO.stageLabel(r)));
    a.appendChild(badge);
    if (r.build) a.appendChild(RO.h("span", "build", r.build));
    a.appendChild(RO.h("span", "sr-only", " (opens the release page in a new tab)"));
    li.appendChild(a);
    return li;
  }

  function render() {
    var list = releases.filter(matches);
    host.textContent = "";
    var group = null, list_ = null;
    list.forEach(function (r) {
      var m = RO.month(r.t);
      if (m !== group) {
        group = m;
        var sec = RO.h("section", "month");
        sec.appendChild(RO.h("h2", "month-h", m));
        list_ = RO.h("ul", "tl");
        sec.appendChild(list_);
        host.appendChild(sec);
      }
      list_.appendChild(item(r));
    });
    var noun = NOUNS[state.stage];
    var which = state.family === "all" ? "" : state.family + " ";
    count.textContent = list.length
      ? list.length + " " + which + (list.length === 1 ? noun[0] : noun[1])
      : "No " + which + noun[1] + " in the data.";
  }

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
    try {
      window.history.replaceState(null, "", window.location.pathname + (q.length ? "?" + q.join("&") : ""));
    } catch (e) { /* the filters still work without a shareable address */ }
  }
  function choose(key, group) {
    return function (event) {
      var chip = event.target.closest ? event.target.closest(".chip") : null;
      if (!chip) return;
      state[key] = chip.getAttribute("data-v");
      press(group, state[key]);
      remember();
      render();
    };
  }
  document.getElementById("chips-family").addEventListener("click", choose("family", "chips-family"));
  document.getElementById("chips-stage").addEventListener("click", choose("stage", "chips-stage"));
  press("chips-family", state.family);
  press("chips-stage", state.stage);

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
    releases = data.releases;
    render();
  });
})();
