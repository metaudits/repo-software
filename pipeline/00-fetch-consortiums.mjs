#!/usr/bin/env node
// Fetch DataCite consortium providers (production) and flatten consortium → orgs.
// Mirrors the reference query but against api.datacite.org (not test).

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { fetchJson } from "./lib/http.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");
if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });

const ENDPOINT = "https://api.datacite.org/providers?member-type=consortium&page[size]=200";

console.log("Fetching consortium providers from DataCite production...");
const raw = await fetchJson(ENDPOINT);

const consortiums = [];
const orgs = []; // flat list of consortium-organization providers (member-type=consortium_organization)

for (const item of raw.data || []) {
  const a = item.attributes || {};
  const rel = item.relationships || {};
  const orgRefs = (rel.consortiumOrganizations?.data || []).map(d => d.id);
  consortiums.push({
    id: item.id,
    name: a.name,
    displayName: a.displayName,
    website: a.website || null,
    country: a.country || null,
    region: a.region || null,
    rorId: a.rorId || null,
    focusArea: a.focusArea || null,
    organizationType: a.organizationType || null,
    nonProfitStatus: a.nonProfitStatus || null,
    isActive: a.isActive,
    joined: a.joined || null,
    created: a.created,
    doiEstimate: a.doiEstimate ?? 0,
    orgIds: orgRefs,
  });
  for (const oid of orgRefs) {
    if (!orgs.find(o => o.id === oid)) orgs.push({ id: oid, consortiumId: item.id });
  }
}

console.log(`  ${consortiums.length} consortiums, ${orgs.length} member organizations.`);

writeFileSync(join(DATA, "consortiums.raw.json"), JSON.stringify(raw, null, 2));
writeFileSync(join(DATA, "consortiums.json"), JSON.stringify(consortiums, null, 2));
writeFileSync(join(DATA, "orgs.json"), JSON.stringify(orgs, null, 2));

console.log(`Wrote data/consortiums.json + data/orgs.json`);
