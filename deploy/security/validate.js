// Runtime check of the security payload (schema 1, ADR 0008) before it is written. Pure: no I/O.
// It holds the shape the page and the Worker rely on; the fuller contract (joins to releases.json,
// sorted lists, notes that exist) stays in tests/support/security_contract.mjs.

// The statuses the builder emits.
const STATUSES = new Set([
  'listed',
  'no-cve-entries',
  'not-found',
  'not-applicable',
  'unavailable',
  'not-connected',
]);

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Every way `payload` breaks the schema-1 shape; empty when it may be written. */
export function payloadProblems(payload) {
  const found = [];
  if (!isObject(payload)) return ['the payload is not an object'];
  if (payload.schema !== 1) found.push('schema must be 1');
  const stamp = typeof payload.generatedAt === 'string' ? Date.parse(payload.generatedAt) : NaN;
  if (!Number.isFinite(stamp)) {
    found.push('generatedAt is not a date');
  }
  for (const key of ['sources', 'notes', 'releases']) {
    if (!isObject(payload[key])) found.push(`${key} is not an object`);
  }
  if (!isObject(payload.releases)) return found;
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
    if (entry.status === 'listed') {
      if (!Number.isInteger(count) || count < 1) found.push(`${id} is listed with count ${count}`);
      if (notes.length === 0) found.push(`${id} is listed without notes`);
      if (count !== cves.length) {
        found.push(`${id}: count ${count} does not match ${cves.length} cves`);
      }
    } else if (entry.status === 'no-cve-entries') {
      if (count !== 0 || cves.length > 0) found.push(`${id} must have count 0 and no cves`);
    } else if (count !== null || cves.length > 0 || notes.length > 0) {
      found.push(`${id} is ${entry.status} and must have count null and no notes or cves`);
    }
  }
  return found;
}
