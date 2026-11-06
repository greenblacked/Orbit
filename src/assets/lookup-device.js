/* The Device list and the line under the "Check my version" answer: that device's validation
   result for the build. lookup.js fetches this file the first time it shows an answer (the
   preview bundle runs it right after lookup.js); it sets window.RODevice.run and runs it.
   devices.json and results/index.json load once; a missing file reads as empty. */
(function (root) {
  "use strict";
  var RO = root.RO, D = root.RODevice, doc = root.document;
  if (!RO || !D) return;
  var extra = null;
  var devKey = "";
  var SAY = { pass: "passed", warn: "passed with warnings", fail: "failed" };

  function more() {
    return extra || (extra = Promise.all(["/data/devices.json", "/data/results/index.json"].map(function (u) {
      return RO.loadJson(u).catch(function () { return {}; });
    })));
  }

  var box = doc.getElementById("lk-dev"), sel = doc.getElementById("lk-device"), out = doc.getElementById("lk-result");
  if (!box || !sel || !out) return;
  D.run = function () {
    var hit = D.hit();
    if (!hit) { box.hidden = true; return; }
    more().then(function (m) {
      var list = (((m[0] || {}).families || {})[hit.family] || {})[hit.major], devs = list && list.devices;
      box.hidden = hit !== D.hit() || !Array.isArray(devs) || !devs.length;
      if (box.hidden) return;
      if (hit.family + hit.major !== devKey) {
        devKey = hit.family + hit.major;
        sel.textContent = "";
        devs.forEach(function (d) { sel.appendChild(RO.h("option", "", d, { value: d })); });
        sel.value = list.default;
        if (!sel.value) sel.selectedIndex = 0;
      }
      var dev = sel.value, rs = (m[1] || {}).results, row = (Array.isArray(rs) ? rs : []).filter(function (r) {
        return r.family === hit.family && r.build === String(hit.build || hit.version) && r.device === dev && SAY[r.status];
      })[0];
      function put(date) {
        if (hit !== D.hit() || sel.value !== dev) return;
        var p = out.querySelector(".lk-dv") || out.appendChild(RO.h("p", "lk-dv"));
        p.textContent = !row ? "Not tested yet on " + dev + "." :
          dev + ": " + SAY[row.status] + (date ? ", tested " + String(date).slice(0, 10) : "");
        if (D.go) {
          out.scrollIntoView({ block: "nearest", behavior: "instant" });
          D.go = 0;
        }
      }
      if (row) RO.loadJson(row.path).then(function (d) { put(d && d.testedAt); }, function () { put(); });
      else put();
    }).catch(function () { box.hidden = true; });
  };
  sel.addEventListener("change", D.run);
  D.run();
})(window);
