// Runtime check of the security payload (schema 1, ADR 0008) before it is written. Pure: no I/O.
// It holds the shape the page and the Worker rely on: the header, the notes map, and each release's
// status, counts, notes and CVEs against that map. The rest of the contract (the join to
// releases.json, patch levels, per-release sources and stages) stays in
// tests/support/security_contract.mjs, which the tests run on what the builder writes.

// The statuses the builder emits.
const STATUSES = new Set([
  'listed',
  'no-cve-entries',
  'not-found',
  'not-applicable',
  'unavailable',
  'not-connected',
]);

const CVE = /^CVE-\d{4}-\d{4,}$/;

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const sortedUnique = (list) => list.every((item, i) => i === 0 || list[i - 1] < item);

// A real https URL: the prefix alone would accept "https://" or "https://[bad".
function isHttpsUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname !== '';
  } catch {
    return false;
  }
}

// Every problem of the notes map: https keys, an object each, a known source, sorted CVE ids.
function noteProblems(payload, found) {
  for (const [url, note] of Object.entries(payload.notes)) {
    if (!isHttpsUrl(url)) found.push(`note ${url} is not https`);
    if (!isObject(note)) {
      found.push(`note ${url} is not an object`);
      continue;
    }
    if (typeof note.source !== 'string' || !Object.hasOwn(payload.sources, note.source)) {
      found.push(`note ${url} names an unknown source`);
    }
    const ids = Array.isArray(note.cves) ? note.cves.map((cve) => cve?.id) : null;
    if (!ids || !ids.every((id) => typeof id === 'string' && CVE.test(id))) {
      found.push(`note ${url} has a bad CVE`);
    } else if (!sortedUnique(ids)) {
      found.push(`note ${url}: cves are not sorted and unique`);
    }
  }
}

/** Every way `payload` breaks the schema-1 shape; empty when it may be written. */
export function payloadProblems(payload) {
  const found = [];
  if (!isObject(payload)) return ['the payload is not an object'];
  if (payload.schema !== 1) found.push('schema must be 1');
  const stamp = typeof payload.generatedAt === 'string' ? Date.parse(payload.generatedAt) : NaN;
  if (!Number.isFinite(stamp)) {
    found.push('generatedAt is not a date');
  }
  const missing = ['sources', 'notes', 'releases'].filter((key) => !isObject(payload[key]));
  for (const key of missing) found.push(`${key} is not an object`);
  if (missing.length > 0) return found;
  noteProblems(payload, found);
  for (const [id, entry] of Object.entries(payload.releases)) {
    if (!isObject(entry)) {
      found.push(`${id} is not an object`);
      continue;
    }
    if (!STATUSES.has(entry.status)) {
      found.push(`${id} has status ${JSON.stringify(entry.status)}`);
      continue;
    }
    if (!Array.isArray(entry.notes) || !Array.isArray(entry.cves)) {
      found.push(`${id}: notes and cves must be arrays`);
      continue;
    }
    const { count, cves, notes } = entry;
    // Every note a release names must exist, and a listed release's CVEs must be exactly those
    // its notes list: none it invents, none it drops.
    const known = new Set();
    for (const url of notes) {
      if (!isHttpsUrl(url)) found.push(`${id} names a note that is not https`);
      if (!Object.hasOwn(payload.notes, url)) {
        found.push(`${id} names a note that is missing: ${url}`);
      } else if (Array.isArray(payload.notes[url]?.cves)) {
        for (const cve of payload.notes[url].cves) known.add(cve?.id);
      }
    }
    if (!sortedUnique(notes)) found.push(`${id}: notes are not sorted and unique`);
    if (!sortedUnique(cves)) found.push(`${id}: cves are not sorted and unique`);
    for (const cve of cves) {
      if (typeof cve !== 'string' || !CVE.test(cve)) found.push(`${id} has a bad CVE ${cve}`);
      else if (!known.has(cve)) found.push(`${id} lists ${cve} that its notes do not`);
    }
    if (entry.status === 'listed') {
      if (!Number.isInteger(count) || count < 1) found.push(`${id} is listed with count ${count}`);
      if (notes.length === 0) found.push(`${id} is listed without notes`);
      if (count !== cves.length) {
        found.push(`${id}: count ${count} does not match ${cves.length} cves`);
      }
      const omitted = [...known].filter((cve) => !cves.includes(cve)).length;
      if (omitted > 0) found.push(`${id} omits ${omitted} cves its notes list`);
    } else if (entry.status === 'no-cve-entries') {
      if (count !== 0 || cves.length > 0) found.push(`${id} must have count 0 and no cves`);
      // A row that says "no CVEs" may not name a note that lists some.
      if (known.size > 0) found.push(`${id} is no-cve-entries but its notes list ${known.size} cves`);
    } else if (count !== null || cves.length > 0 || notes.length > 0) {
      found.push(`${id} is ${entry.status} and must have count null and no notes or cves`);
    }
  }
  return found;
}
