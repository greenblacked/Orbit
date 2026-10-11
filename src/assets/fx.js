/* Visual effects, loaded as a module after the first paint (home.js adds it once the page has
   loaded and the browser is idle). Everything here is progressive: the page is complete without
   it, and every effect is gated on the visitor allowing motion and on the feature it needs. */
const root = document.documentElement;
const motionOk = !!window.matchMedia && matchMedia("(prefers-reduced-motion: no-preference)").matches;

// Exploded orbit, fallback half. Where the browser has scroll-driven animations the CSS does the
// whole effect (see "Exploded orbit" in site.css). Elsewhere this adds a class to the dial's
// stage once it has mostly scrolled away above the viewport, and the CSS transitions to the same
// tilted, separated state. Classes only: no style is written.
function explodeFallback() {
  const stage = document.getElementById("orbit-stage");
  if (!stage || !("IntersectionObserver" in window)) return;
  if (window.CSS && CSS.supports && CSS.supports("animation-timeline: view()")) return;
  const steps = [];
  for (let i = 0; i <= 10; i++) steps.push(i / 10);
  new IntersectionObserver((entries) => {
    const e = entries[entries.length - 1];
    stage.classList.toggle("out", e.intersectionRatio < 0.4 && e.boundingClientRect.top < 0);
  }, { threshold: steps }).observe(stage);
}

if (motionOk) {
  explodeFallback();
}
