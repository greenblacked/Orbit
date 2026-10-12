/* Visual effects, loaded as a module after the first paint (home.js adds it once the page has
   loaded and the browser is idle). Everything here is progressive: the page is complete without
   it, and every effect is gated on the visitor allowing motion and on the feature it needs. */
const root = document.documentElement;
const motionOk = !!window.matchMedia && matchMedia("(prefers-reduced-motion: no-preference)").matches;
const reduce = window.matchMedia ? matchMedia("(prefers-reduced-motion: reduce)") : null;
const reduced = () => !!reduce && reduce.matches;

// Reduce Motion turned on after the effects loaded: the pointer highlight and the refraction
// stop at once (the aurora watches the setting itself).
function onReduce(e) {
  if (!e.matches) return;
  root.classList.remove("fx-glass", "fx-refract");
}
if (reduce) {
  if (reduce.addEventListener) reduce.addEventListener("change", onReduce);
  else if (reduce.addListener) reduce.addListener(onReduce);
}

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

// Liquid-light glass on the cards. A pointer-following specular highlight: the pointer's
// position inside the hovered card goes into two custom properties (--mx, --my) and the CSS
// paints a soft highlight at that spot. Only for a fine pointer that can hover; a finger has
// no hover to follow.
const GLASS = ".rel, .orbit-card";
function glass() {
  if (!matchMedia("(hover: hover) and (pointer: fine)").matches) return;
  root.classList.add("fx-glass");
  let frame = 0;
  let last = null;
  const paint = () => {
    frame = 0;
    if (reduced()) return;
    const card = last.target.closest(GLASS);
    if (!card) return;
    const box = card.getBoundingClientRect();
    card.style.setProperty("--mx", Math.round(last.x - box.left) + "px");
    card.style.setProperty("--my", Math.round(last.y - box.top) + "px");
  };
  document.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch" || !e.target.closest || !e.target.closest(GLASS)) return;
    last = { target: e.target, x: e.clientX, y: e.clientY };
    if (!frame) frame = requestAnimationFrame(paint);
  }, { passive: true });
}

// Refraction: an SVG feTurbulence and feDisplacementMap filter that bends a card a little while
// it is hovered (the CSS applies it to .rel:hover only, a single element at a time). Added only
// where the engine accepts a filter reference, so nothing changes elsewhere.
function refraction() {
  if (!window.CSS || !CSS.supports || !CSS.supports("filter", "url(#fx-refract)")) return;
  const NS = "http://www.w3.org/2000/svg";
  const make = (tag, attrs, parent) => {
    const node = document.createElementNS(NS, tag);
    for (const key in attrs) node.setAttribute(key, attrs[key]);
    if (parent) parent.appendChild(node);
    return node;
  };
  const svg = make("svg", { width: 0, height: 0, "aria-hidden": "true", focusable: "false", "class": "fx-defs" });
  const filter = make("filter", { id: "fx-refract", x: "-4%", y: "-4%", width: "108%", height: "108%" }, svg);
  make("feTurbulence", { type: "fractalNoise", baseFrequency: "0.012 0.02", numOctaves: 2, seed: 7, result: "noise" }, filter);
  make("feDisplacementMap", { in: "SourceGraphic", in2: "noise", scale: 4, xChannelSelector: "R", yChannelSelector: "G" }, filter);
  document.body.appendChild(svg);
  root.classList.add("fx-refract");
}

// Aurora: a WebGL canvas behind the hero, its own lazily imported module. Skipped when the
// visitor asked to save data, on a device that reports four or fewer cores, and (inside the
// module) when there is no WebGL or the first second of frames is slow; the CSS gradient blobs
// stay as the fallback.
function aurora() {
  const host = document.querySelector(".hero-wrap .aurora");
  if (!host) return;
  const link = navigator.connection;
  if (link && link.saveData) return;
  if (navigator.hardwareConcurrency <= 4) return;
  // Six blobs, so the first six accents: one per vendor first, then the second of each, so a
  // vendor listed later (RouterOS, Android, Windows, SteamOS) is not crowded out by Apple's six.
  const seen = {};
  const colors = window.RO
    ? RO.families()
        .map((f) => ({ accent: f.accent, rank: (seen[f.vendor] = (seen[f.vendor] || 0) + 1) }))
        .sort((a, b) => a.rank - b.rank)
        .map((f) => f.accent)
    : [];
  import("./aurora.js").then((m) => m.default(host, colors)).catch(() => {});
}

if (motionOk) {
  glass();
  refraction();
  aurora();
}
