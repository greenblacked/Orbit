// Tests for the build sigil (src/assets/sigil.js, rule in docs/sigils.md): the geometry of the
// six worked examples and of three generic builds, pinned number by number.
// node --test 'tests/*.test.mjs'    (node:test and node:assert only; nothing to install)

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const Sigil = createRequire(import.meta.url)('../src/assets/sigil.js');

// A document just big enough for the glyph: createElementNS, setAttribute, appendChild.
const element = (tag) => ({
  tag,
  attrs: {},
  children: [],
  style: {
    props: {},
    setProperty(key, value) {
      this.props[key] = String(value);
    },
  },
  setAttribute(key, value) {
    this.attrs[key] = String(value);
  },
  appendChild(child) {
    this.children.push(child);
    return child;
  },
});
const doc = { createElementNS: (_ns, tag) => element(tag) };
const draw = (build, size, opts = {}) => Sigil.svg(build, size, { doc, ...opts });

const num = (el, key) => Number(el.attrs[key]);
const near = (actual, expected, tolerance, what) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} is not ${expected}`);
const polar = (deg, r) => [r * Math.sin((deg * Math.PI) / 180), -r * Math.cos((deg * Math.PI) / 180)];

// Size 210 makes R = 100 px per unit, so the pixel values below read as the spec's units x 100.
const R = 100;
const sizeOf = (R * 2.1).toFixed(0);

function parts(root) {
  const circles = root.children.filter((el) => el.tag === 'circle');
  return {
    rings: circles.filter((el) => el.attrs.cx === undefined),
    dots: circles.filter((el) => el.attrs.cx !== undefined),
    lines: root.children.filter((el) => el.tag === 'line'),
  };
}
const length = (line) =>
  Math.hypot(num(line, 'x2') - num(line, 'x1'), num(line, 'y2') - num(line, 'y1'));

// The six real builds of the spec, with the spec's own numbers.
const EXAMPLES = [
  {
    build: '24B5099f', rings: 5, t: 1, dots: 6,
    lengths: [0.05, 0.3, 0.3, 0.189, 0.05, 0.3, 0.3, 0.189, 0.05, 0.3, 0.3],
    micro: [0.1, 0.3, 0.3, 0.2, 0.1, 0.3, 0.3, 0.2, 0.1, 0.3, 0.3],
  },
  {
    build: '26B5101f', rings: 2, t: 1, dots: 6,
    lengths: [0.078, 0.05, 0.078, 0.189, 0.078, 0.05, 0.078, 0.189, 0.078, 0.05, 0.078],
    micro: [0.1, 0.1, 0.1, 0.2, 0.1, 0.1, 0.1, 0.2, 0.1, 0.1, 0.1],
  },
  {
    build: '24K5103f', rings: 5, t: 10, dots: 6,
    lengths: [0.05, 0.133, 0.189, 0.078, 0.05, 0.133, 0.189, 0.078, 0.05, 0.133, 0.189],
    micro: [0.1, 0.2, 0.2, 0.1, 0.1, 0.2, 0.2, 0.1, 0.1, 0.2, 0.2],
  },
  {
    build: '24N5103f', rings: 5, t: 13, dots: 6,
    lengths: [0.078, 0.05, 0.133, 0.189, 0.078, 0.05, 0.133, 0.189, 0.078, 0.05, 0.133],
    micro: [0.1, 0.1, 0.2, 0.2, 0.1, 0.1, 0.2, 0.2, 0.1, 0.1, 0.2],
  },
  {
    build: '23G90', rings: 4, t: 6, dots: 0,
    lengths: [0.3, 0.05, 0.3, 0.05, 0.3, 0.05, 0.3, 0.05, 0.3, 0.05, 0.3],
    micro: [0.3, 0.1, 0.3, 0.1, 0.3, 0.1, 0.3, 0.1, 0.3, 0.1, 0.3],
  },
  {
    build: '19H422', rings: 5, t: 7, dots: 0,
    lengths: [0.106, 0.106, 0.161, 0.106, 0.106, 0.161, 0.106, 0.106, 0.161, 0.106, 0.106],
    micro: [0.1, 0.1, 0.2, 0.1, 0.1, 0.2, 0.1, 0.1, 0.2, 0.1, 0.1],
  },
];

// The generic builds: what the rule in docs/sigils.md gives, worked out by hand.
const GENERIC = [
  { build: 'BP2A.250605.031', rings: 5, t: 15, dots: 4, digits: [2, 8, 3, 5, 1, 6, 0, 4] },
  { build: '26100.4351', rings: 5, t: 19, dots: 1, digits: [3, 7, 6, 3, 4, 6, 3, 1] },
  { build: '24.04.3', rings: 4, t: 9, dots: 3, digits: [4, 9, 7, 8, 0, 1, 7, 8] },
];

function checkFull(root, { rings, rot, dots, lengths }) {
  const { rings: circles, dots: dotEls, lines } = parts(root);
  assert.equal(root.attrs.viewBox, '-105.000 -105.000 210.000 210.000');
  assert.equal(root.attrs.width, sizeOf);
  assert.equal(root.attrs.stroke, 'currentColor');
  assert.equal(circles.length, rings);
  circles.forEach((ring, index) => {
    const j = index + 1;
    near(num(ring, 'r'), R * (0.18 + (0.52 * j) / rings), 0.001, `ring ${j} radius`);
    near(num(ring, 'stroke-width'), j === rings ? 2.6 : 1.4, 0.001, `ring ${j} width`);
  });
  assert.equal(num(circles[rings - 1], 'r'), 70);
  assert.equal(lines.length, 11);
  lines.forEach((line, k) => {
    const [x, y] = polar(rot + (k * 360) / 11, 70);
    near(num(line, 'x1'), x, 0.002, `spoke ${k} x`);
    near(num(line, 'y1'), y, 0.002, `spoke ${k} y`);
    // Outward, on the same ray: the tip lies at the start radius plus the length.
    const [tx, ty] = polar(rot + (k * 360) / 11, 70 + lengths[k] * R);
    near(num(line, 'x2'), tx, 0.06, `spoke ${k} tip x`);
    near(num(line, 'y2'), ty, 0.06, `spoke ${k} tip y`);
    near(length(line), lengths[k] * R, 0.06, `spoke ${k} length`);
    near(num(line, 'stroke-width'), k === 0 ? 4 : 2, 0.001, `spoke ${k} width`);
  });
  // The first dot caps the index spoke; the others are the suffix dots on r = 10.
  assert.equal(dotEls.length, 1 + dots);
  const [cap, ...suffix] = dotEls;
  near(num(cap, 'r'), 3.5, 0.001, 'cap radius');
  near(num(cap, 'cx'), num(lines[0], 'x2'), 0.002, 'cap x');
  near(num(cap, 'cy'), num(lines[0], 'y2'), 0.002, 'cap y');
  suffix.forEach((dot, i) => {
    const [x, y] = polar(rot + (i * 360) / dots, 10);
    near(num(dot, 'cx'), x, 0.002, `dot ${i} x`);
    near(num(dot, 'cy'), y, 0.002, `dot ${i} y`);
    near(num(dot, 'r'), 3.2, 0.001, `dot ${i} radius`);
  });
}

describe('the Apple rule, full form', () => {
  for (const example of EXAMPLES) {
    it(`draws ${example.build} as the spec says`, () => {
      checkFull(draw(example.build, 210), { ...example, rot: (example.t * 360) / 26 });
    });
  }

  it('reads the grammar LEAD TRAIN NUM SUFFIX', () => {
    assert.deepEqual(Sigil.parse('24B5099f'), {
      rings: 5, t: 1, digits: [5, 0, 9, 9], dots: 6, generic: false,
    });
    assert.deepEqual(Sigil.parse('23G90'), { rings: 4, t: 6, digits: [9, 0], dots: 0, generic: false });
    assert.equal(Sigil.parse('24B5099a').dots, 1);
    assert.equal(Sigil.parse('24B5099z').dots, 6);
  });

  it('is a different shape, not a rotation, when only the train letter differs', () => {
    const k = parts(draw('24K5103f', 210)).lines.map(length);
    const n = parts(draw('24N5103f', 210)).lines.map(length);
    assert.notDeepEqual(k.map((v) => v.toFixed(2)), n.map((v) => v.toFixed(2)));
  });

  it('draws the guide circle only when asked and only from 40 px up', () => {
    assert.equal(parts(draw('24B5099f', 210)).rings.length, 5);
    const guided = draw('24B5099f', 210, { guide: true });
    assert.equal(parts(guided).rings.length, 6);
    near(num(guided.children[0], 'r'), 100, 0.001, 'guide radius');
    assert.equal(guided.children[0].attrs['stroke-opacity'], '0.22');
    assert.equal(parts(draw('24B5099f', 24, { guide: true })).rings.length, 1);
  });

  it('never strokes thinner than one pixel or draws a dot under one pixel', () => {
    const { rings, dots, lines } = parts(draw('24B5099f', 40));
    for (const el of [...rings, ...lines]) assert.ok(num(el, 'stroke-width') >= 1, el.tag);
    for (const el of dots) assert.ok(num(el, 'r') >= 1);
    near(num(rings[rings.length - 1], 'stroke-width'), 1, 0.001, 'outer ring at 40 px');
  });

  it('marks the shapes for the draw-in only when asked', () => {
    const plain = draw('24B5099f', 210);
    assert.equal(plain.attrs.class, 'sigil-svg');
    assert.equal(plain.children[0].attrs.pathLength, undefined);
    for (const el of plain.children) assert.deepEqual(el.style.props, {});
  });

  it('marks every shape for the draw-in when asked, dots fading instead of drawing', () => {
    const born = draw('24B5099f', 210, { birth: true });
    assert.equal(born.attrs.class, 'sigil-svg birth');
    assert.ok(born.children.length > 0);
    born.children.forEach((el, index) => {
      const isDot = el.attrs.cx !== undefined;
      assert.equal(el.attrs.pathLength, isDot ? undefined : '1', `${el.tag} ${index} pathLength`);
      assert.equal(el.style.props['--i'], String(index), `${el.tag} ${index} stagger`);
    });
    const { dots } = parts(born);
    assert.ok(dots.every((dot) => dot.attrs.class === 'sd'));
  });
});

// A host element just big enough for Sigil.draw.
const hostElement = () => ({
  ownerDocument: doc,
  attrs: {},
  children: [],
  getAttribute(key) {
    return this.attrs[key] ?? null;
  },
  setAttribute(key, value) {
    this.attrs[key] = String(value);
  },
  removeAttribute(key) {
    delete this.attrs[key];
  },
  set textContent(_value) {
    this.children = [];
  },
  get firstChild() {
    return this.children[0] ?? null;
  },
  appendChild(child) {
    this.children.push(child);
    return child;
  },
});

describe('draw into a host', () => {
  it('draws a new sigil in, and leaves the same build and size alone', () => {
    const host = hostElement();
    Sigil.draw(host, '24B5099f', { size: 64 });
    const first = host.firstChild;
    assert.equal(first.attrs.class, 'sigil-svg birth');
    assert.equal(host.attrs['data-build'], '24B5099f');
    assert.equal(host.attrs['data-size'], '64');
    Sigil.draw(host, '24B5099f', { size: 64 });
    assert.equal(host.firstChild, first, 'the same build is not redrawn');
    assert.equal(host.children.length, 1);
  });

  it('redraws when the build or the size changes, and clears for no build', () => {
    const host = hostElement();
    Sigil.draw(host, '24B5099f', { size: 64 });
    const first = host.firstChild;
    Sigil.draw(host, '24A446', { size: 64 });
    assert.notEqual(host.firstChild, first, 'a changed build is redrawn');
    assert.equal(host.attrs['data-build'], '24A446');
    const second = host.firstChild;
    Sigil.draw(host, '24A446', { size: 96 });
    assert.notEqual(host.firstChild, second, 'a changed size is redrawn');
    Sigil.draw(host, '', { size: 96 });
    assert.equal(host.firstChild, null);
    assert.equal(host.attrs['data-build'], undefined);
  });

  it('skips the draw-in when birth is off', () => {
    const host = hostElement();
    Sigil.draw(host, '24B5099f', { size: 64, birth: false });
    assert.equal(host.firstChild.attrs.class, 'sigil-svg');
  });
});

describe('the micro form (under 40 px)', () => {
  for (const example of EXAMPLES) {
    it(`draws ${example.build} at 24 px`, () => {
      const root = draw(example.build, 24);
      const unit = 24 / 2.1;
      const { rings, dots, lines } = parts(root);
      assert.equal(rings.length, 1);
      near(num(rings[0], 'r'), 0.7 * unit, 0.001, 'ring radius');
      assert.equal(num(rings[0], 'stroke-width'), 1.5);
      assert.equal(lines.length, 11);
      lines.forEach((line, k) => {
        const [x, y] = polar((example.t * 360) / 26 + (k * 360) / 11, 0.7 * unit);
        near(num(line, 'x1'), x, 0.002, `spoke ${k} x`);
        near(num(line, 'y1'), y, 0.002, `spoke ${k} y`);
        const [tx, ty] = polar((example.t * 360) / 26 + (k * 360) / 11, (0.7 + example.micro[k]) * unit);
        near(num(line, 'x2'), tx, 0.002, `spoke ${k} tip x`);
        near(num(line, 'y2'), ty, 0.002, `spoke ${k} tip y`);
        near(length(line), example.micro[k] * unit, 0.002, `spoke ${k} length`);
        assert.equal(num(line, 'stroke-width'), k === 0 ? 2 : 1);
      });
      // The cap on the index spoke, and one centre dot for any suffix.
      assert.equal(dots.length, example.dots ? 2 : 1);
      assert.equal(num(dots[0], 'r'), 1.5);
      if (example.dots) {
        assert.equal(num(dots[1], 'cx'), 0);
        assert.equal(num(dots[1], 'cy'), 0);
        assert.equal(num(dots[1], 'r'), 2);
      }
    });
  }

  it('switches form at 40 px', () => {
    assert.equal(parts(draw('24B5099f', 39)).rings.length, 1);
    assert.equal(parts(draw('24B5099f', 40)).rings.length, 5);
  });
});

describe('the generic rule', () => {
  for (const g of GENERIC) {
    it(`hashes ${g.build} into rings, train, dots and eight digits`, () => {
      const p = Sigil.parse(g.build);
      assert.equal(p.generic, true);
      assert.equal(p.rings, g.rings);
      assert.equal(p.t, g.t);
      assert.equal(p.dots, g.dots);
      assert.deepEqual(p.digits, g.digits);
    });

    it(`draws ${g.build} with the same geometry as an Apple build`, () => {
      const lengths = Array.from({ length: 11 }, (_, k) => 0.05 + (0.25 * g.digits[(k + g.t) % 8]) / 9);
      checkFull(draw(g.build, 210), { rings: g.rings, rot: (g.t * 360) / 26, dots: g.dots, lengths });
    });
  }

  it('ignores case and punctuation, and is deterministic', () => {
    assert.deepEqual(Sigil.parse('bp2a-250605-031'), Sigil.parse('BP2A.250605.031'));
    assert.deepEqual(Sigil.parse('24.04.3'), Sigil.parse('24.04.3'));
    assert.notDeepEqual(Sigil.parse('24.04.3'), Sigil.parse('24.04.2'));
  });

  it('draws something for an empty or odd string', () => {
    for (const text of ['', '---', 'Ünï']) {
      const p = Sigil.parse(text);
      assert.equal(p.digits.length, 8);
      assert.ok(p.rings >= 1 && p.rings <= 5);
      assert.ok(p.t >= 0 && p.t < 26);
      assert.ok(p.dots >= 0 && p.dots <= 6);
    }
    assert.equal(parts(draw('', 210)).lines.length, 11);
  });

  it('draws a generic build in the micro form too', () => {
    const { rings, lines, dots } = parts(draw('26100.4351', 24));
    assert.equal(rings.length, 1);
    assert.equal(lines.length, 11);
    // dots = 1 here, so the cap and the centre dot.
    assert.equal(dots.length, 2);
  });
});

describe('the SVG', () => {
  it('is built from elements, labelled only when asked', () => {
    const root = draw('24B5099f', 64);
    assert.equal(root.tag, 'svg');
    assert.equal(root.attrs['aria-hidden'], 'true');
    assert.equal(root.attrs.focusable, 'false');
    const named = draw('24B5099f', 64, { label: 'Sigil of build 24B5099f' });
    assert.equal(named.attrs.role, 'img');
    assert.equal(named.attrs['aria-label'], 'Sigil of build 24B5099f');
    assert.equal(named.attrs['aria-hidden'], undefined);
  });

  it('strokes in the colour it is given', () => {
    const root = draw('24B5099f', 64, { color: '#d7452f' });
    assert.equal(root.attrs.stroke, '#d7452f');
    assert.equal(parts(root).dots[0].attrs.fill, '#d7452f');
  });

  it('is the same glyph every time', () => {
    const a = JSON.stringify(draw('24B5099f', 96));
    const b = JSON.stringify(draw('24B5099f', 96));
    assert.equal(a, b);
  });
});
