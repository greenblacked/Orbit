// The executable contract of the security notes payload (schema 1, ADR 0008), shared by
// tests/security.test.mjs and the adapter tests so there is one definition of "valid".

const STATUSES = [
  'listed',
  'no-cve-entries',
  'not-found',
  'not-applicable',
  'unavailable',
  'not-connected',
];
const CVE = /^CVE-\d{4}-\d{4,}$/;

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

// A real calendar day written YYYY-MM-DD (the form of a patch level).
function isDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(at.getTime()) && at.toISOString().startsWith(value);
}

const sortedUnique = (list) => list.every((item, i) => i === 0 || list[i - 1] < item);
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Every problem a payload has against `rows` (the releases it may describe); empty when valid.
// A release key must already be in releases.json: live releases can run ahead of the snapshot,
// so notes for a newer release wait until `node deploy/snapshot_releases.mjs` has run.
export function problems(payload, rows) {
  const found = [];
  const stages = new Map(rows.map((row) => [row.id, row.stage]));
  if (payload.schema !== 1) found.push('schema must be 1');
  if (typeof payload.generatedAt !== 'string' || !Number.isFinite(Date.parse(payload.generatedAt))) {
    found.push('generatedAt is not a date');
  }
  for (const key of ['sources', 'notes', 'releases']) {
    if (!isObject(payload[key])) found.push(`${key} is not an object`);
  }
  if (found.length > 0) return found;
  for (const [url, note] of Object.entries(payload.notes)) {
    if (!isHttpsUrl(url)) found.push(`note ${url} is not https`);
    if (!isObject(note)) {
      found.push(`note ${url} is not an object`);
      continue;
    }
    if (!(note.source in payload.sources)) found.push(`note ${url} names an unknown source`);
    const ids = Array.isArray(note.cves) ? note.cves.map((cve) => cve?.id) : null;
    if (!ids || !ids.every((id) => typeof id === 'string' && CVE.test(id))) {
      found.push(`note ${url} has a bad CVE`);
    } else if (!sortedUnique(ids)) {
      found.push(`note ${url}: cves are not sorted and unique`);
    }
  }
  for (const [id, entry] of Object.entries(payload.releases)) {
    if (!isObject(entry)) {
      found.push(`${id} is not an object`);
      continue;
    }
    const stage = stages.get(id);
    if (stage === undefined) found.push(`${id} is not in releases.json`);
    if (!STATUSES.includes(entry.status)) found.push(`${id} has status ${entry.status}`);
    if (entry.patchLevel !== undefined && entry.patchLevel !== null && !isDay(entry.patchLevel)) {
      found.push(`${id} has a bad patchLevel`);
    }
    const listsNotes = entry.status === 'listed' || entry.status === 'no-cve-entries';
    if (listsNotes && stage !== 'release') found.push(`${id} lists notes but is a ${stage}`);
    if (stage && stage !== 'release' && entry.status !== 'not-applicable') {
      found.push(`${id} is a ${stage} and must be not-applicable`);
    }
    if (!Array.isArray(entry.notes) || !Array.isArray(entry.cves)) {
      found.push(`${id}: notes and cves must be arrays`);
      continue;
    }
    const known = new Set();
    for (const url of entry.notes) {
      if (!isHttpsUrl(url)) found.push(`${id} names a note that is not https`);
      if (!(url in payload.notes)) found.push(`${id} names a note that is missing: ${url}`);
      else for (const cve of payload.notes[url].cves ?? []) known.add(cve?.id);
    }
    if (!sortedUnique(entry.notes)) found.push(`${id}: notes are not sorted and unique`);
    if (!sortedUnique(entry.cves)) found.push(`${id}: cves are not sorted and unique`);
    for (const cve of entry.cves) {
      if (typeof cve !== 'string' || !CVE.test(cve)) found.push(`${id} has a bad CVE ${cve}`);
      else if (!known.has(cve)) found.push(`${id} lists ${cve} that its notes do not`);
    }
    if (entry.status === 'listed') {
      if (entry.notes.length === 0) found.push(`${id} is listed without notes`);
      if (entry.cves.length === 0) found.push(`${id} is listed without cves`);
      if (entry.count !== entry.cves.length) found.push(`${id}: count does not match cves`);
    } else if (entry.status === 'no-cve-entries') {
      if (entry.cves.length > 0 || entry.count !== 0) found.push(`${id} must have no cves and count 0`);
    } else if (entry.notes.length > 0 || entry.cves.length > 0 || entry.count !== null) {
      found.push(`${id} must have no notes or cves and count null`);
    }
  }
  return found;
}
