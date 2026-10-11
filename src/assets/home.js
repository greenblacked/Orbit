/* Front page: the live indicator and the latest release per platform family. */
(function () {
  "use strict";
  var RO = window.RO;
  var live = document.getElementById("live");
  var liveText = document.getElementById("live-text");
  var cards = document.querySelectorAll("#latest-grid [data-family]");
  var signature = "";

  function setLive(kind, text) {
    live.setAttribute("data-state", kind);
    liveText.textContent = text;
  }
  function paintLive(data, failed) {
    if (!data) {
      setLive("error", failed ? "Could not load releases. The source is linked below." : "Loading…");
      return;
    }
    var when = data.fetchedAt ? RO.stamp(data.fetchedAt) : "";
    if (failed) setLive("stale", "Could not reach the tracker, showing data from " + when);
    else if (data.stale) setLive("stale", "Stale: the source was unreachable, showing the last copy from " + when);
    else if (data.snapshot) setLive("snapshot", "Saved copy from " + when + ", not live");
    else setLive("live", "Live: fetched at " + when);
  }

  function paintCard(card, r) {
    var set = function (name, text) { card.querySelector('[data-f="' + name + '"]').textContent = text; };
    if (!r) { set("ver", "No release yet"); return; }
    set("ver", r.family + " " + r.version);
    set("stage", RO.stageLabel(r));
    set("build", r.build ? "Build " + r.build : "");
    card.setAttribute("data-stage", r.stage);
    var tile = card.querySelector('[data-f="major"]');
    tile.textContent = String(r.major);
    var when = card.querySelector('[data-f="when"]');
    when.textContent = "";
    when.appendChild(document.createTextNode(RO.day(r.t) + " · "));
    when.appendChild(RO.when(r.t));
    var link = card.querySelector('[data-f="link"]');
    link.href = r.url;
    link.hidden = false;
    card.querySelector('[data-f="badge"]').hidden = false;
  }

  RO.on(function (data, fresh, failed) {
    paintLive(data, failed);
    if (!data) return;
    var next = data.releases.map(function (r) { return r.id; }).join("|");
    if (next === signature) return;
    signature = next;
    for (var i = 0; i < cards.length; i++) {
      var family = cards[i].getAttribute("data-family");
      paintCard(cards[i], RO.latest(data.releases, family, false));
    }
  });
})();
