#!/usr/bin/env node
// Fetch real DOI counts per client by hitting /dois?client-id=X&page[size]=1
// and reading meta.total. This is what Ted Habermann's analyses use as the
// denominator for FAIR completeness — a real record count, not the now-deprecated
// `doiEstimate` admin field that DataCite no longer populates.
// Optional: skip if you only care about platform detection, not DOI volume.

import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { fetchJson, mapConcurrent } from "./lib/http.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");
const FILE = join(DATA, "clients.enriched.json");
if (!existsSync(FILE)) {
  console.error("Missing data/clients.enriched.json — run pipeline:enrich first.");
  process.exit(1);
}
const clients = JSON.parse(readFileSync(FILE, "utf8"));

// Resume support: cache by client id so a partial run doesn't repeat work.
const CACHE_FILE = join(DATA, "doi-counts.json");
const cache = existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, "utf8")) : {};

async function fetchCount(clientId) {
  if (cache[clientId] != null) return cache[clientId];
  try {
    const r = await fetchJson(`https://api.datacite.org/dois?client-id=${encodeURIComponent(clientId)}&page[size]=1`, { retries: 4 });
    const n = r?.meta?.total ?? 0;
    cache[clientId] = n;
    return n;
  } catch (e) {
    return null;
  }
}

console.log(`Fetching real DOI counts for ${clients.length} clients...`);
const counts = await mapConcurrent(
  clients.map(c => c.id),
  fetchCount,
  4,
  (d, t) => {
    if (d % 100 === 0 || d === t) {
      console.log(`  ${d}/${t}`);
      writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    }
  },
);

const updated = clients.map((c, i) => ({ ...c, doiCount: counts[i] }));
writeFileSync(FILE, JSON.stringify(updated, null, 2));
writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));

const total = counts.filter(n => typeof n === "number").reduce((a, b) => a + b, 0);
const nonEmpty = counts.filter(n => n > 0).length;
console.log(`Done. Total DOIs across consortium clients: ${total.toLocaleString()}.`);
console.log(`Clients with at least 1 DOI: ${nonEmpty} / ${clients.length}.`);
