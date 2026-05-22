#!/usr/bin/env node
// Population-level completeness: for each software-identified client with DOIs,
// ask DataCite for the count of DOIs where each of the 12 fields is populated.
// This replaces the 3-DOI sampling in 05-completeness with EXACT per-client rates
// over the full DOI population.
//
// Why this matters: a 3-DOI sample is biased (DataCite default order ≈ recency,
// so recently-improved templates show up) and noisy (especially for clients with
// hundreds of thousands of DOIs). By facet-querying the index directly we get the
// exact share of populated DOIs per client per field — no statistical uncertainty
// inside a client. The remaining uncertainty (across clients per platform) is
// genuine sampling of clients-running-platform-X.
//
// Cost: 13 GETs per identified client (1 total + 12 fields). For ~2,012 clients
// that's ~26k API calls. With concurrency=6 and DataCite's polite rate limit it
// takes ~30–60 min. Cache resumable.
//
// Output: data/field-counts-cache.json — per-client { total, byField }.

import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { fetchJson, mapConcurrent } from "./lib/http.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");
const FILE = join(DATA, "clients.enriched.json");
const CACHE = join(DATA, "field-counts-cache.json");

const clients = JSON.parse(readFileSync(FILE, "utf8"));
const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};

// 12 fields aligned with Habermann's four use cases. Each value is the DataCite
// query that returns `meta.total` = count of DOIs in the client where that field
// is populated. Paths were verified empirically (see CLAUDE.md).
const FIELD_QUERIES = {
  // Text
  titles:               "titles.title:*",
  descriptions:         "descriptions.description:*",
  subjects:             "subjects.subject:*",
  // Identifiers
  relatedIdentifiers:   "relatedIdentifiers.relatedIdentifier:*",
  alternateIdentifiers: "alternateIdentifiers.alternateIdentifier:*",
  version:              "version:*",
  // Connections
  fundingReferences:    "fundingReferences:*",
  container:            "container:*",
  geoLocations:         "geoLocations:*",
  // Contacts
  creators:             "creators.name:*",
  creatorOrcid:         "creators.nameIdentifiers.nameIdentifierScheme:ORCID",
  contributors:         "contributors.name:*",
};

const BASE = "https://api.datacite.org/dois";

async function countForQuery(clientId, query) {
  const enc = encodeURIComponent(query);
  const url = `${BASE}?client-id=${encodeURIComponent(clientId)}&query=${enc}&page[size]=0`;
  const j = await fetchJson(url, { retries: 7 });   // up from 3 → 7 because of 429 storms
  return j?.meta?.total ?? 0;
}

async function totalForClient(clientId) {
  const url = `${BASE}?client-id=${encodeURIComponent(clientId)}&page[size]=0`;
  const j = await fetchJson(url, { retries: 7 });
  return j?.meta?.total ?? 0;
}

async function processClient(clientId) {
  if (cache[clientId]?.complete) return cache[clientId];
  const existing = cache[clientId] ?? { byField: {} };
  try {
    // Always re-read total in case the client's DOI count moved.
    const total = await totalForClient(clientId);
    if (!total) {
      cache[clientId] = { total: 0, byField: {}, complete: true };
      return cache[clientId];
    }
    const byField = { ...(existing.byField ?? {}) };
    for (const [field, query] of Object.entries(FIELD_QUERIES)) {
      if (typeof byField[field] === "number") continue;   // already fetched
      try {
        byField[field] = await countForQuery(clientId, query);
      } catch (e) {
        // Persist partial progress so a re-run picks up where this failed.
        cache[clientId] = { total, byField, complete: false, error: String(e) };
        return cache[clientId];
      }
    }
    cache[clientId] = { total, byField, complete: true };
    return cache[clientId];
  } catch (e) {
    cache[clientId] = { ...existing, complete: false, error: String(e) };
    return cache[clientId];
  }
}

// Candidate set: clients with software identified AND ≥1 DOI minted at DataCite.
// (No URL or liveness requirement — we're asking DataCite about its own index.)
const candidates = clients.filter(c => c.softwareDetected && (c.doiCount || 0) > 0);
console.log(`Counting populated-field totals for ${candidates.length} identified clients (13 queries each).`);
console.log(`Approx ${candidates.length * 13} API calls; resumable cache at ${CACHE}.`);

let done = 0;
// Concurrency lowered from 6 → 3 because DataCite was returning 429s in bursts.
// http.mjs now respects Retry-After and uses 2s/4s/8s/16s/32s backoff so even
// a sustained 429 will recover, but keeping concurrency moderate avoids the
// thundering-herd that triggered them in the first place.
await mapConcurrent(
  candidates.map(c => c.id),
  async (id) => {
    const r = await processClient(id);
    done++;
    if (done % 25 === 0) writeFileSync(CACHE, JSON.stringify(cache, null, 2));
    return r;
  },
  2,                                                  // gentler — DataCite throttles
  (d, t) => { if (d % 50 === 0 || d === t) console.log(`  ${d}/${t}`); },
);

writeFileSync(CACHE, JSON.stringify(cache, null, 2));

// Coverage diagnostic
const complete = candidates.filter(c => cache[c.id]?.complete).length;
const partial = candidates.filter(c => cache[c.id] && !cache[c.id].complete).length;
console.log("");
console.log(`Complete: ${complete}/${candidates.length}, partial/error: ${partial}`);
console.log(`Wrote ${CACHE}`);
