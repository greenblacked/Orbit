/* Page script: theme control, header that hides while reading down, Back, the bar,
   To top. */
(function () {
  var KEY = "theme";
  var COLORS = { day: "#f4f1ea", night: "#000000", reactor: "#070807" };
  var root = document.documentElement;
  var meta = document.querySelector('meta[name="theme-color"]');
  var dark = document.getElementById("dark-switch");
  var consoleTheme = document.getElementById("console-theme");
  // With no stored choice the theme is the system setting, read when the page loads and
  // again when the system changes it. The clock is only the fallback for a browser without
  // matchMedia, and nothing re-themes a visible page on a timer.
  var scheme = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  function system() {
    var hour = new Date().getHours();
    var night = scheme ? scheme.matches : hour >= 20 || hour < 6;
    return night ? "night" : "day";
  }
  function stored() {
    var value = null;
    try { value = localStorage.getItem(KEY); } catch (e) {}
    return value === "night" || value === "day" || value === "reactor" ? value : null;
  }
  function preferred() { return stored() || system(); }
  function apply(theme) {
    root.setAttribute("data-theme", theme);
    if (meta) meta.setAttribute("content", COLORS[theme]);
    // Both dark themes are dark: the switch is on in the night and the console themes, and
    // turning it off from the console theme goes to day.
    dark.setAttribute("aria-checked", theme === "day" ? "false" : "true");
    consoleTheme.setAttribute("aria-pressed", theme === "reactor" ? "true" : "false");
  }
  function store(value) {
    try {
      if (value) localStorage.setItem(KEY, value);
      else localStorage.removeItem(KEY);
    } catch (e) {}
  }
  dark.addEventListener("click", function () {
    var next = root.getAttribute("data-theme") === "day" ? "night" : "day";
    store(next);
    apply(next);
  });
  consoleTheme.addEventListener("click", function () {
    if (root.getAttribute("data-theme") === "reactor") {
      store(null);
      apply(system());
      return;
    }
    store("reactor");
    apply("reactor");
  });
  apply(preferred());
  function follow() { if (!stored()) apply(system()); }
  if (scheme && scheme.addEventListener) scheme.addEventListener("change", follow);
  else if (scheme && scheme.addListener) scheme.addListener(follow);

  var home = document.getElementById("home");
  home.addEventListener("click", function (event) {
    if (window.location.pathname === "/") {
      event.preventDefault();
      window.scrollTo(0, 0);
    }
  });
  var banner = document.getElementById("banner");
  var last = window.scrollY;
  function away(on) {
    banner.classList.toggle("away", on);
    banner.inert = on;
  }
  window.addEventListener("scroll", function () {
    var y = window.scrollY;
    var delta = y - last;
    if (y <= 64) away(false);
    else if (delta > 8) away(true);
    else if (delta < -8) away(false);
    last = y;
  }, { passive: true });

  var backs = document.querySelectorAll("[data-back]");
  function back(event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var from = "";
    try { from = new URL(document.referrer).origin; } catch (e) {}
    if (from !== window.location.origin || window.history.length < 2) return;
    event.preventDefault();
    window.history.back();
  }
  for (var b = 0; b < backs.length; b++) backs[b].addEventListener("click", back);

  var dock = document.getElementById("dock");
  var upward = document.getElementById("to-top");
  var still = window.matchMedia("(prefers-reduced-motion: reduce)");
  function edge() {
    var inline = document.querySelector("main .back");
    if (!inline) return 320;
    return inline.getBoundingClientRect().bottom + window.scrollY;
  }
  var limit = edge();
  // To top follows the header's rule: away while reading down, back on the way up,
  // when a reader wants it, and at the end of the page. A focused button stays, so
  // keyboard focus never lands on something hidden.
  var mark = window.scrollY;
  var shown = false;
  function reveal() {
    var y = window.scrollY;
    var past = y > limit;
    if (dock) dock.classList.toggle("on", past);
    var end = y + window.innerHeight >= document.documentElement.scrollHeight - 2;
    if (!past) shown = false;
    else if (end || document.activeElement === upward) shown = true;
    else if (y < mark - 8) shown = true;
    else if (y > mark + 8) shown = false;
    if (Math.abs(y - mark) > 8) mark = y;
    upward.classList.toggle("on", shown);
  }
  window.addEventListener("scroll", reveal, { passive: true });
  window.addEventListener("resize", function () { limit = edge(); reveal(); });
  reveal();
  upward.addEventListener("click", function () {
    window.scrollTo({ top: 0, behavior: still.matches ? "auto" : "smooth" });
    // The button hides once the page is at the top, so focus moves to the home link,
    // in the header, which is inert while it is hidden.
    away(false);
    home.focus({ preventScroll: true });
  });
})();
