#!/usr/bin/env node
// For every consortium, paginate /clients?consortium-id=XXX&include=provider.
// This returns *all* clients across the consortium's member orgs in one stream,
// with the parent provider record inlined — so we get client attributes
// (software, url, re3data, repositoryType, …) and provider attributes
// (country, region, name) in a single set of paginated requests per consortium.

import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { fetchJson, mapConcurrent, sleep } from "./lib/http.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");
const CONSORTIUMS_FILE = join(DATA, "consortiums.json");
if (!existsSync(CONSORTIUMS_FILE)) {
  console.error("Missing data/consortiums.json — run pipeline:consortiums first.");
  process.exit(1);
}
const consortiums = JSON.parse(readFileSync(CONSORTIUMS_FILE, "utf8"));

const PAGE_SIZE = 1000;
const MAX_PAGES = 50;

function normalizeClient(it) {
  const a = it.attributes || {};
  return {
    id: it.id,
    providerId: it.relationships?.provider?.data?.id || null,
    name: a.name,
    symbol: a.symbol,
    description: (a.description || "").slice(0, 400),
    url: a.url || null,
    repositoryType: Array.isArray(a.repositoryType)
      ? a.repositoryType
      : (a.repositoryType ? [a.repositoryType] : []),
    software: a.software || null,
    re3data: a.re3data || null,
    clientType: a.clientType || null,
    isActive: a.isActive,
    created: a.created,
    updated: a.updated,
    doiEstimate: a.doiEstimate ?? 0,
  };
}

function normalizeProvider(it) {
  const a = it.attributes || {};
  return {
    id: it.id,
    name: a.name,
    displayName: a.displayName || a.name,
    country: a.country || null,
    region: a.region || null,
    rorId: a.rorId || null,
    memberType: a.memberType || null,
    isActive: a.isActive,
  };
}

async function fetchClientsForConsortium(consortiumId) {
  const clients = [];
  const providersById = new Map();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://api.datacite.org/clients?consortium-id=${encodeURIComponent(consortiumId)}&include=provider&page[size]=${PAGE_SIZE}&page[number]=${page}`;
    let res;
    try { res = await fetchJson(url, { retries: 5 }); }
    catch (e) {
      console.error(`  [${consortiumId} p${page}] ${e}`);
      break;
    }
    const data = res.data || [];
    for (const it of data) clients.push(normalizeClient(it));
    for (const it of res.included || []) {
      if (it.type === "providers" && !providersById.has(it.id)) {
        providersById.set(it.id, normalizeProvider(it));
      }
    }
    const totalPages = res.meta?.totalPages ?? 1;
    if (page >= totalPages) break;
  }
  return { consortiumId, clients, providers: [...providersById.values()] };
}

console.log(`Fetching clients per consortium (concurrency 3)...`);
const results = await mapConcurrent(
  consortiums.map(c => c.id),
  fetchClientsForConsortium,
  3,
  (d, t) => console.log(`  consortium ${d}/${t}`),
);

// Merge across consortiums
const allClients = [];
const allProviders = new Map();
let clientCountByConsortium = {};
for (const r of results) {
  if (!r || !r.clients) continue;
  clientCountByConsortium[r.consortiumId] = r.clients.length;
  for (const c of r.clients) allClients.push(c);
  for (const p of r.providers) if (!allProviders.has(p.id)) allProviders.set(p.id, p);
}

// Some clients might appear under multiple consortiums (rare); dedupe by id.
const seen = new Set();
const dedup = [];
for (const c of allClients) {
  if (seen.has(c.id)) continue;
  seen.add(c.id);
  dedup.push(c);
}

console.log(`Fetched ${allClients.length} clients (deduped: ${dedup.length}) across ${results.length} consortiums.`);
console.log(`Distinct providers seen: ${allProviders.size}.`);

writeFileSync(join(DATA, "providers.json"), JSON.stringify([...allProviders.values()], null, 2));
writeFileSync(join(DATA, "clients.json"), JSON.stringify(dedup, null, 2));
writeFileSync(join(DATA, "clients.per-consortium.json"), JSON.stringify(clientCountByConsortium, null, 2));
console.log(`Wrote data/providers.json + data/clients.json + data/clients.per-consortium.json`);
