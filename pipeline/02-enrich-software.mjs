#!/usr/bin/env node
// Detect repository software for each DataCite client. DataCite production does not
// expose a `software` field on /clients, so detection is two-tiered:
//   1. re3data lookup — for clients with a re3data DOI (~6.5%), resolve the DOI to a
//      re3data repo ID (via a one-shot dump of re3data's full repo list), then fetch
//      the detail XML and read <r3d:softwareName>.
//   2. HTML heuristic — for clients with a URL but no re3data record, fetch the
//      homepage and match against well-known generator/footer signatures.
// Output: data/clients.enriched.json + data/re3data-index.json (cached for re-runs).

import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { fetchText, mapConcurrent } from "./lib/http.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");
const CLIENTS_FILE = join(DATA, "clients.json");
if (!existsSync(CLIENTS_FILE)) {
  console.error("Missing data/clients.json — run pipeline:clients first.");
  process.exit(1);
}
const clients = JSON.parse(readFileSync(CLIENTS_FILE, "utf8"));

// ─── Build / load re3data DOI → repoId index ───────────────────────────────
const INDEX_FILE = join(DATA, "re3data-index.json");
let re3index;
if (existsSync(INDEX_FILE)) {
  re3index = JSON.parse(readFileSync(INDEX_FILE, "utf8"));
  console.log(`Loaded cached re3data index (${Object.keys(re3index).length} entries).`);
} else {
  console.log("Fetching full re3data repository list (one shot)...");
  const { text, status } = await fetchText("https://www.re3data.org/api/v1/repositories", { timeoutMs: 60000 });
  if (status !== 200) {
    console.error(`re3data list fetch failed: HTTP ${status}`);
    process.exit(1);
  }
  re3index = {};
  // Parse: <repository><id>r3d…</id><doi>https://doi.org/10.17616/…</doi>…</repository>
  const re = /<repository>\s*<id>\s*(r3d[0-9]+)\s*<\/id>\s*<doi>\s*([^<]+?)\s*<\/doi>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const id = m[1].trim();
    const doi = m[2].trim().toLowerCase();
    re3index[doi] = id;
  }
  writeFileSync(INDEX_FILE, JSON.stringify(re3index, null, 2));
  console.log(`  built index with ${Object.keys(re3index).length} repos. Cached.`);
}

// Helper: resolve DataCite's re3data DOI value (with various forms) to re3data id.
function resolveRe3id(raw) {
  if (!raw) return null;
  const norm = String(raw).trim().toLowerCase();
  if (re3index[norm]) return re3index[norm];
  // DataCite sometimes stores just the DOI suffix
  const m = norm.match(/10\.\d{4,9}\/[a-z0-9._-]+/i);
  if (m) {
    const key = `https://doi.org/${m[0]}`;
    if (re3index[key]) return re3index[key];
  }
  return null;
}

// ─── re3data detail lookup (cached) ────────────────────────────────────────
const DETAIL_CACHE_FILE = join(DATA, "re3data-software.json");
const detailCache = existsSync(DETAIL_CACHE_FILE) ? JSON.parse(readFileSync(DETAIL_CACHE_FILE, "utf8")) : {};

async function softwareFromRe3data(re3id) {
  if (detailCache[re3id] !== undefined) return detailCache[re3id];
  const { text, status } = await fetchText(`https://www.re3data.org/api/v1/repository/${re3id}`, { timeoutMs: 30000 });
  let sw = null;
  if (status === 200 && text) {
    const m = text.match(/<r3d:softwareName[^>]*>([^<]+)<\/r3d:softwareName>/i);
    if (m) sw = m[1].trim();
  }
  detailCache[re3id] = sw;
  return sw;
}

// ─── HTML heuristic ────────────────────────────────────────────────────────
const SIGNATURES = [
  { name: "DSpace",        re: /<meta[^>]+name=["']generator["'][^>]+content=["'][^"']*DSpace/i },
  { name: "DSpace",        re: /Powered\s+by\s+(?:the\s+)?DSpace|DSpace\s+(?:7|6|software|repository)/i },
  { name: "Dataverse",     re: /<meta[^>]+name=["']generator["'][^>]+content=["'][^"']*Dataverse/i },
  { name: "Dataverse",     re: /Powered\s+by\s+Dataverse|dataverse\.org/i },
  { name: "EPrints",       re: /<meta[^>]+name=["']generator["'][^>]+content=["'][^"']*EPrints/i },
  { name: "EPrints",       re: /Powered\s+by\s+EPrints|eprints\.org/i },
  { name: "InvenioRDM",    re: /InvenioRDM|invenio-rdm/i },
  { name: "Invenio",       re: /<meta[^>]+name=["']generator["'][^>]+content=["'][^"']*Invenio/i },
  { name: "Invenio",       re: /Powered\s+by\s+Invenio|invenio-app/i },
  { name: "Zenodo",        re: /Zenodo\s+is\s+(?:developed|operated)|zenodo\.org/i },
  { name: "CKAN",          re: /<meta[^>]+name=["']generator["'][^>]+content=["'][^"']*CKAN/i },
  { name: "CKAN",          re: /Powered\s+by\s+CKAN|ckan\.org/i },
  { name: "Figshare",      re: /figshare\.com|Powered\s+by\s+figshare/i },
  { name: "OJS",           re: /Open\s+Journal\s+Systems|<meta[^>]+content=["'][^"']*OJS\s+[0-9]/i },
  { name: "Samvera/Hyrax", re: /Hyrax|Samvera/i },
  { name: "Fedora",        re: /Fedora\s+Commons|fcrepo/i },
  { name: "Islandora",     re: /Islandora/i },
  { name: "MyCoRe",        re: /MyCoRe/i },
  { name: "Omeka",         re: /Omeka(\s+S)?/i },
  { name: "Drupal",        re: /<meta[^>]+name=["']generator["'][^>]+content=["'][^"']*Drupal/i },
  { name: "WordPress",     re: /<meta[^>]+name=["']generator["'][^>]+content=["'][^"']*WordPress/i },
];

function detectFromHtml(html) {
  if (!html) return null;
  const slice = html.slice(0, 200000);
  for (const sig of SIGNATURES) {
    if (sig.re.test(slice)) return sig.name;
  }
  return null;
}

// ─── Run ───────────────────────────────────────────────────────────────────
const withRe3 = clients.filter(c => c.re3data && resolveRe3id(c.re3data));
const withRe3Unmapped = clients.filter(c => c.re3data && !resolveRe3id(c.re3data));
const withUrl = clients.filter(c => !c.re3data && c.url);

console.log(`re3data eligible: ${withRe3.length} (with cached/index mapping)`);
console.log(`re3data unmapped: ${withRe3Unmapped.length} (DOI not in re3data list)`);
console.log(`URL-only eligible: ${withUrl.length}`);
console.log(`Skipping (no url + no re3data): ${clients.length - withRe3.length - withRe3Unmapped.length - withUrl.length}`);

const enriched = await mapConcurrent(
  clients,
  async (c) => {
    // re3data first
    const rid = resolveRe3id(c.re3data);
    if (rid) {
      const sw = await softwareFromRe3data(rid);
      if (sw) return { ...c, softwareSource: "re3data", softwareDetected: sw, re3id: rid };
    }
    // HTML heuristic
    if (c.url) {
      const { text } = await fetchText(c.url, { timeoutMs: 10000 });
      const sw = detectFromHtml(text);
      if (sw) return { ...c, softwareSource: "html-detect", softwareDetected: sw };
    }
    return { ...c, softwareSource: null, softwareDetected: null };
  },
  6,
  (d, t) => {
    if (d % 100 === 0 || d === t) console.log(`  enriching ${d}/${t}`);
  },
);

writeFileSync(DETAIL_CACHE_FILE, JSON.stringify(detailCache, null, 2));
writeFileSync(join(DATA, "clients.enriched.json"), JSON.stringify(enriched, null, 2));

const re3hits = enriched.filter(c => c.softwareSource === "re3data").length;
const htmlHits = enriched.filter(c => c.softwareSource === "html-detect").length;
const noHit = enriched.filter(c => !c.softwareSource).length;
console.log("");
console.log(`Detection results:`);
console.log(`  re3data:     ${re3hits}`);
console.log(`  HTML detect: ${htmlHits}`);
console.log(`  unknown:     ${noHit}`);
console.log(`Wrote data/clients.enriched.json + data/re3data-software.json`);
