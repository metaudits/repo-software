#!/usr/bin/env node
// Sibling propagation: if a provider has ≥3 identified clients and ≥80% of them
// run the same software, label its remaining unknown clients with that software
// (softwareSource: "inferred-siblings"). No HTTP — pure CPU on existing data.
//
// Tradeoff: not as authoritative as direct detection. Use the "Detection source"
// badge in the UI to surface that these labels are inferred, not observed.
//
// Output: in-place update of data/clients.enriched.json.

import { writeFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");
const FILE = join(DATA, "clients.enriched.json");
const clients = JSON.parse(readFileSync(FILE, "utf8"));

const MIN_IDENTIFIED = 3;     // need ≥3 identified siblings to draw a conclusion
const MIN_RATIO      = 0.8;   // need ≥80% of identified siblings on the same platform

// Group by providerId
const byProvider = new Map();
for (const c of clients) {
  if (!c.providerId) continue;
  if (!byProvider.has(c.providerId)) byProvider.set(c.providerId, []);
  byProvider.get(c.providerId).push(c);
}

let inferredHits = 0;
const skipped = { tooFewIdentified: 0, tooFragmented: 0, noUnknowns: 0 };
const inferredByPlatform = {};

for (const [providerId, group] of byProvider) {
  const identified = group.filter(c => c.softwareDetected);
  if (identified.length < MIN_IDENTIFIED) { skipped.tooFewIdentified++; continue; }

  // Build histogram of platforms among identified siblings
  const histo = new Map();
  for (const c of identified) {
    histo.set(c.softwareDetected, (histo.get(c.softwareDetected) || 0) + 1);
  }
  const [topPlatform, topCount] = [...histo.entries()].sort((a, b) => b[1] - a[1])[0];
  const ratio = topCount / identified.length;
  if (ratio < MIN_RATIO) { skipped.tooFragmented++; continue; }

  const unknowns = group.filter(c => !c.softwareDetected);
  if (unknowns.length === 0) { skipped.noUnknowns++; continue; }

  for (const u of unknowns) {
    u.softwareDetected = topPlatform;
    u.softwareSource = "inferred-siblings";
    u.inferredFromCount = topCount;
    u.inferredFromRatio = ratio;
    inferredHits++;
    inferredByPlatform[topPlatform] = (inferredByPlatform[topPlatform] || 0) + 1;
  }
}

writeFileSync(FILE, JSON.stringify(clients, null, 2));
console.log(`Sibling propagation:`);
console.log(`  providers evaluated:    ${byProvider.size}`);
console.log(`  skipped (<3 identified): ${skipped.tooFewIdentified}`);
console.log(`  skipped (fragmented):   ${skipped.tooFragmented}`);
console.log(`  skipped (no unknowns):  ${skipped.noUnknowns}`);
console.log(`  hits inferred:          ${inferredHits}`);
console.log(`  by platform:`);
for (const [p, n] of Object.entries(inferredByPlatform).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${p.padEnd(20)} ${n}`);
}
console.log(`Updated data/clients.enriched.json`);
