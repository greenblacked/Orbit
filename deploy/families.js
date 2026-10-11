// The platform families the site knows, and the accent colour of each.
//
// The list lives in src/data/families.json, so the pages read the very same file the
// build publishes at /data/families.json and the Worker and the snapshot script import
// here. A family belongs to one vendor; a source adapter only emits families of its own
// vendor.

import data from '../src/data/families.json' with { type: 'json' };

export const FAMILIES = data.families;

/** The ids of the families of one vendor, in display order. */
export function familyIds(vendor) {
  return FAMILIES.filter((family) => family.vendor === vendor).map((family) => family.id);
}
