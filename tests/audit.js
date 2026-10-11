// Run in the page by test_accessibility.py: returns a list of problems, empty when clean.
() => {
  const problems = [];
  const text = (el) => (el.innerText || "").replace(/\s+/g, " ").trim();
  const name = (el) => {
    const label = el.getAttribute("aria-label");
    if (label && label.trim()) return label.trim();
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const joined = by.split(/\s+/).map((id) => document.getElementById(id))
        .filter(Boolean).map((n) => n.textContent.trim()).join(" ").trim();
      if (joined) return joined;
    }
    const own = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (own) return own;
    const img = el.querySelector("img[alt]");
    if (img && img.alt.trim()) return img.alt.trim();
    return (el.getAttribute("title") || "").trim();
  };
  const root = document.documentElement;
  if (!root.lang) problems.push("html has no lang");
  if (!document.title.trim()) problems.push("page has no title");
  const count = (sel) => document.querySelectorAll(sel).length;
  if (count("main, [role=main]") !== 1) problems.push("expected exactly one main landmark");
  if (count("body > header") !== 1) problems.push("expected exactly one banner (body > header)");
  if (count("body > footer") !== 1) problems.push("expected exactly one contentinfo (body > footer)");
  const navs = [...document.querySelectorAll("nav")];
  navs.forEach((nav) => { if (!nav.getAttribute("aria-label")) problems.push("a nav has no aria-label"); });
  const labels = navs.map((nav) => nav.getAttribute("aria-label")).filter(Boolean);
  if (new Set(labels).size !== labels.length) problems.push("two navs share an aria-label");
  const h1 = [...document.querySelectorAll("h1")];
  if (h1.length !== 1) problems.push("expected exactly one h1, found " + h1.length);
  let last = 0;
  document.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((h) => {
    const level = Number(h.tagName[1]);
    if (last && level > last + 1) problems.push("heading level jumps from h" + last + " to h" + level);
    last = level;
    if (!text(h)) problems.push("an empty heading");
  });
  document.querySelectorAll("img").forEach((img) => {
    if (!img.hasAttribute("alt")) problems.push("img without alt: " + img.src);
  });
  document.querySelectorAll("a[href], button, [role=button], [role=switch]").forEach((el) => {
    const n = name(el);
    if (!n) { problems.push("no accessible name: " + el.outerHTML.slice(0, 80)); return; }
    const aria = el.getAttribute("aria-label");
    const visible = text(el).toLowerCase();
    if (aria && visible && !aria.toLowerCase().includes(visible)) {
      problems.push("label '" + aria + "' lacks visible text '" + visible + "' (2.5.3)");
    }
  });
  const ids = {};
  document.querySelectorAll("[id]").forEach((el) => {
    ids[el.id] = (ids[el.id] || 0) + 1;
  });
  Object.entries(ids).forEach(([id, n]) => { if (n > 1) problems.push("duplicate id " + id); });
  document.querySelectorAll("a[href^='#']").forEach((a) => {
    const id = decodeURIComponent(a.getAttribute("href").slice(1));
    if (id && !document.getElementById(id)) problems.push("fragment target missing: #" + id);
  });
  document.querySelectorAll("[aria-labelledby], [aria-describedby]").forEach((el) => {
    ["aria-labelledby", "aria-describedby"].forEach((attr) => {
      (el.getAttribute(attr) || "").split(/\s+/).filter(Boolean).forEach((id) => {
        if (!document.getElementById(id)) problems.push(attr + " names a missing id " + id);
      });
    });
  });
  return problems;
}
