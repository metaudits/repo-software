#!/usr/bin/env node
// OAI-PMH probe: most academic repositories expose an OAI-PMH endpoint at one
// of a handful of standard paths. The ?verb=Identify response is a small XML
// document that often names the software in <repositoryName>, <adminEmail>,
// <description>, or implicit format conventions of the protocol output.
//
// Strategy per client (only those still without software label):
//   1. Try paths in order: /oai, /oai/request, /cgi/oai2, /oai2d, /oai/openaire
//   2. First 200 + valid XML response → run a signature library against the body
//   3. Cache results to avoid re-probing on future runs
//
// Output: updates data/clients.enriched.json in place. New softwareSource: "oai-pmh".

import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { fetchText, mapConcurrent } from "./lib/http.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");
const FILE = join(DATA, "clients.enriched.json");
const CACHE_FILE = join(DATA, "oai-probe-cache.json");
const clients = JSON.parse(readFileSync(FILE, "utf8"));
const cache = existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, "utf8")) : {};

const OAI_PATHS = ["/oai", "/oai/request", "/cgi/oai2", "/oai2d", "/oai/openaire", "/oai-pmh"];

const SIGNATURES = [
  // ordered: more specific first
  { name: "DSpace",        re: /DSpace at\s|<software>\s*DSpace|dspace[-_ ]?(?:cris|api|repo)/i },
  { name: "Dataverse",     re: /<dc:source>[^<]*dataverse|Dataverse Network|dataverse-collection/i },
  { name: "EPrints",       re: /<repositoryName>[^<]*EPrints|\beprints\.org\b|<adminEmail>[^@]*@eprints/i },
  { name: "InvenioRDM",    re: /InvenioRDM|invenio-rdm|inveniordm/i },
  { name: "Invenio",       re: /<oai-identifier>[\s\S]*?invenio|powered by invenio/i },
  { name: "Zenodo",        re: /<repositoryName>[^<]*Zenodo|<protocolVersion>2.0<\/protocolVersion>[\s\S]*?zenodo/i },
  { name: "OJS",           re: /Open Journal Systems|<repositoryName>[^<]*OJS\s/i },
  { name: "CKAN",          re: /<repositoryName>[^<]*CKAN|powered by ckan/i },
  { name: "Samvera/Hyrax", re: /Hyrax|Samvera/i },
  { name: "Fedora",        re: /Fedora Commons|fcrepo/i },
  { name: "Islandora",     re: /Islandora/i },
  { name: "MyCoRe",        re: /MyCoRe/i },
  { name: "Omeka",         re: /Omeka/i },
  { name: "OPUS",          re: /OPUS\s?(?:[345]|repository)/i },
  { name: "Figshare",      re: /<repositoryName>[^<]*figshare/i },
];

function detect(body) {
  if (!body) return null;
  const sample = body.slice(0, 30000);
  for (const s of SIGNATURES) {
    if (s.re.test(sample)) return s.name;
  }
  return null;
}

function normalizeUrl(u) {
  if (!u) return null;
  if (u.includes("@") && !u.startsWith("http")) return null;
  if (/^https?:\/\//i.test(u)) return u.replace(/\/+$/, "");
  if (/^[a-z0-9.-]+\.[a-z]{2,}/i.test(u)) return `https://${u.replace(/\/+$/, "")}`;
  return null;
}

async function probeOai(rootUrl) {
  for (const path of OAI_PATHS) {
    const url = `${rootUrl}${path}?verb=Identify`;
    const { text, status } = await fetchText(url, { timeoutMs: 8000, retries: 1 });
    if (status !== 200 || !text) continue;
    // Must look like an OAI-PMH response
    if (!/<OAI-PMH/i.test(text) && !/<Identify/i.test(text)) continue;
    const sw = detect(text);
    if (sw) return { path, software: sw };
    // Even if no signature matched, we still got a valid OAI response — record it
    return { path, software: null };
  }
  return null;
}

const candidates = clients
  .map((c, i) => ({ idx: i, c }))
  .filter(({ c }) => !c.softwareDetected && c.url);

console.log(`OAI probe target: ${candidates.length} unknowns with URL.`);
console.log(`Cached entries:    ${Object.keys(cache).length}`);

let probed = 0;
const results = await mapConcurrent(
  candidates,
  async ({ idx, c }) => {
    const root = normalizeUrl(c.url);
    if (!root) return { idx, sw: null };
    if (cache[c.id] !== undefined) return { idx, sw: cache[c.id]?.software || null };
    let res = null;
    try { res = await probeOai(root); }
    catch { res = null; }
    cache[c.id] = res || { software: null };
    probed++;
    if (probed % 50 === 0) writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    return { idx, sw: res?.software || null };
  },
  6,
  (d, t) => { if (d % 50 === 0 || d === t) console.log(`  oai ${d}/${t}`); },
);

writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));

let hits = 0;
for (const { idx, sw } of results) {
  if (sw && !clients[idx].softwareDetected) {
    clients[idx].softwareDetected = sw;
    clients[idx].softwareSource = "oai-pmh";
    hits++;
  }
}
writeFileSync(FILE, JSON.stringify(clients, null, 2));

console.log("");
console.log(`OAI-PMH hits: ${hits}`);
console.log(`Updated data/clients.enriched.json + data/oai-probe-cache.json`);
