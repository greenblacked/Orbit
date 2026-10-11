/* The generic build sigil rule (docs/sigils.md, "Generic builds"): how a build string that is
   not an Apple build becomes the parameters of a sigil. sigil.js loads this file only when
   such a build first appears, and in Node (the tests) requires it at once. */
(function (global) {
  "use strict";
  function install(Sigil) {
    var SPEC = Sigil.SPEC;
    // The generic rule: a Fletcher-style checksum of the letters and digits (upper-cased,
    // everything else ignored) gives rings, train and dots; a small linear congruential
    // generator seeded from that checksum gives the digits. Pure integer arithmetic, so every
    // engine draws the same glyph.
    function generic(text) {
      var s = String(text).toUpperCase().replace(/[^A-Z0-9]/g, "") || "0";
      var a = 1, b = 0, i, x, digits = [];
      for (i = 0; i < s.length; i++) {
        a = (a + s.charCodeAt(i)) % SPEC.hashMod;
        b = (b + a) % SPEC.hashMod;
      }
      x = a * SPEC.hashMod + b;
      for (i = 0; i < SPEC.genericDigits; i++) {
        x = (x * SPEC.lcgMul + SPEC.lcgAdd) % SPEC.lcgMod;
        digits.push(x % 10);
      }
      return {
        rings: 1 + (a % SPEC.ringMod), t: b % SPEC.trains, digits: digits,
        dots: a % (SPEC.maxDots + 1), generic: true
      };
    }
    Sigil.generic = generic;
    Sigil.use(generic);
  }
  if (typeof module !== "undefined" && module.exports) module.exports = install;
  else if (global.Sigil) install(global.Sigil);
})(typeof window !== "undefined" ? window : this);
