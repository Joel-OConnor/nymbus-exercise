import { VENDORS, type Vendor } from "@nymbus/shared";
import { seeded } from "./random";

export interface SimTenant {
  tenantId: string;
  name: string;
  vendor: Vendor;
  /** Steady-state transactions per second from this tenant's vendor connection. */
  baseTps: number;
  /** BIN prefixes this tenant owns; traffic is routed on these. */
  bins: string[];
}

const PREFIXES = [
  "First", "Heritage", "Harbor", "Pioneer", "Liberty", "Granite", "Prairie", "Coastal", "Union", "Cedar",
  "Riverside", "Northern", "Keystone", "Evergreen", "Lakeside", "Frontier", "Meadow", "Horizon", "Beacon", "Summit",
  "Sterling", "Oakridge", "Bluewater", "Redwood", "Ironbridge",
];
const SUFFIXES = ["Bank", "Credit Union", "Savings Bank", "Trust", "Community Bank", "Federal Credit Union"];

/**
 * Deterministically build the tenant population described in the brief:
 * ~50 tenants, each on one of five EFT vendors, most at ~2 tps with a few large
 * institutions at ~15 tps. Default population lands at ~135-140 tps total.
 */
export function buildTenants(count: number, tpsScale: number): SimTenant[] {
  const rnd = seeded(20261031);
  const vendors = Object.keys(VENDORS) as Vendor[];
  const largeCount = Math.max(1, Math.round(count * 0.06));
  const largeIdx = new Set<number>();
  for (let i = 0; i < largeCount; i++) largeIdx.add(Math.floor((i * count) / largeCount));

  const tenants: SimTenant[] = [];
  for (let i = 0; i < count; i++) {
    const id = `t${String(i + 1).padStart(3, "0")}`;
    const name = `${PREFIXES[i % PREFIXES.length]} ${SUFFIXES[Math.floor(i / PREFIXES.length) % SUFFIXES.length]}`;
    const vendor = vendors[Math.floor(rnd() * vendors.length)];
    const baseTps = (largeIdx.has(i) ? 13 + rnd() * 4 : 1.5 + rnd()) * tpsScale;
    const bins = [String(400000 + Math.floor(rnd() * 99999)), String(510000 + Math.floor(rnd() * 99999))];
    tenants.push({ tenantId: id, name, vendor, baseTps, bins });
  }
  return tenants;
}
