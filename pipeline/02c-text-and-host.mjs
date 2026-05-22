#!/usr/bin/env node
// Second offline patch: detect software via (a) platform keywords in
// client.name + client.description, (b) hostname shortcuts for known
// shared infrastructures. No HTTP calls — pure CPU.
//
// Examples of shared hosts we hard-map:
//   sanad.iau.ir  → OJS  (Iran's national university journal portal, 250+ titles)
//   opus4.*       → OPUS 4 (German KOBV network)
//   gfzpublic.gfz.de → GFZ Publish (custom DSpace fork)
//   datadryad.org → Dryad

import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");
const FILE = join(DATA, "clients.enriched.json");
const clients = JSON.parse(readFileSync(FILE, "utf8"));

// (a) Keyword → platform mapping for name / description text scan
const KEYWORDS = [
  { re: /dspace/i,              name: "DSpace" },
  { re: /dataverse/i,           name: "Dataverse" },
  { re: /eprints/i,             name: "EPrints" },
  { re: /invenio[- ]?rdm/i,     name: "InvenioRDM" },
  { re: /\binvenio\b/i,         name: "Invenio" },
  { re: /\bckan\b/i,             name: "CKAN" },
  { re: /figshare/i,            name: "Figshare" },
  { re: /\bzenodo\b/i,           name: "Zenodo" },
  { re: /samvera|hyrax/i,       name: "Samvera/Hyrax" },
  { re: /fedora\s+commons/i,    name: "Fedora" },
  { re: /islandora/i,           name: "Islandora" },
  { re: /omeka/i,               name: "Omeka" },
  { re: /mycore/i,              name: "MyCoRe" },
  { re: /geonetwork/i,          name: "GeoNetwork" },
  { re: /\bopus[\s-]?[45]/i,    name: "OPUS" },
  { re: /open\s+journal\s+systems|\bojs\b/i, name: "OJS" },
  { re: /geonode/i,             name: "GeoNode" },
  { re: /dryad/i,               name: "Dryad" },
  { re: /\bdrupal\b/i,           name: "Drupal" },
  { re: /wordpress/i,           name: "WordPress" },
];

// (b) Hostname → platform (exact or suffix match). Aggregator infrastructures.
const HOST_MAP = [
  { match: /(^|\.)sanad\.iau\.ir$/i,       name: "OJS" },
  { match: /(^|\.)opus4?\.[a-z0-9.-]+/i,   name: "OPUS" },
  { match: /(^|\.)datadryad\.org$/i,       name: "Dryad" },
  { match: /(^|\.)zenodo\.org$/i,          name: "Zenodo" },
  { match: /(^|\.)figshare\.com$/i,        name: "Figshare" },
  { match: /(^|\.)dataverse\.[a-z0-9.-]+/i, name: "Dataverse" },
  { match: /(^|\.)geonetwork\.[a-z0-9.-]+/i, name: "GeoNetwork" },
  { match: /(^|\.)redalyc\.org$/i,         name: "OJS" },
  { match: /(^|\.)scielo\.[a-z.]+$/i,      name: "SciELO" },
  { match: /(^|\.)arxiv\.org$/i,           name: "arXiv" },
];

function hostnameOf(url) {
  try {
    if (!url) return null;
    const u = url.startsWith("http") ? url : `https://${url}`;
    return new URL(u).hostname.toLowerCase();
  } catch { return null; }
}

function detectFromText(c) {
  const text = `${c.name || ""} ${c.description || ""}`;
  for (const k of KEYWORDS) {
    if (k.re.test(text)) return k.name;
  }
  return null;
}

function detectFromHost(c) {
  const h = hostnameOf(c.url);
  if (!h) return null;
  for (const m of HOST_MAP) {
    if (m.match.test(h)) return m.name;
  }
  return null;
}

// Also fix re3data DOI matches that the index missed. The DOIs are case
// sensitive in re3data's listing but DataCite stores them upper/mixed-case.
// Re-load the re3data index and try a looser match.
const INDEX_FILE = join(DATA, "re3data-index.json");
const re3index = existsSync(INDEX_FILE) ? JSON.parse(readFileSync(INDEX_FILE, "utf8")) : {};

function resolveRe3id(raw) {
  if (!raw) return null;
  const norm = String(raw).trim().toLowerCase();
  if (re3index[norm]) return re3index[norm];
  const m = norm.match(/10\.\d{4,9}\/[a-z0-9._-]+/i);
  if (m) {
    const variants = [
      `https://doi.org/${m[0]}`,
      `http://doi.org/${m[0]}`,
      `doi:${m[0]}`,
      m[0],
    ];
    for (const v of variants) if (re3index[v]) return re3index[v];
  }
  return null;
}

// re3data detail cache (built by step 02)
const DETAIL_CACHE_FILE = join(DATA, "re3data-software.json");
const detailCache = existsSync(DETAIL_CACHE_FILE) ? JSON.parse(readFileSync(DETAIL_CACHE_FILE, "utf8")) : {};

let textHits = 0, hostHits = 0, re3FixHits = 0;
const out = clients.map(c => {
  if (c.softwareDetected) return c;
  // (1) retry re3data with looser DOI normalization
  if (c.re3data) {
    const rid = resolveRe3id(c.re3data);
    if (rid && detailCache[rid]) {
      re3FixHits++;
      return { ...c, softwareSource: "re3data", softwareDetected: detailCache[rid], re3id: rid };
    }
  }
  // (2) text scan
  const t = detectFromText(c);
  if (t) { textHits++; return { ...c, softwareSource: "name-desc", softwareDetected: t }; }
  // (3) host map
  const h = detectFromHost(c);
  if (h) { hostHits++; return { ...c, softwareSource: "host-map", softwareDetected: h }; }
  return c;
});

writeFileSync(FILE, JSON.stringify(out, null, 2));
console.log(`re3data fixed:    ${re3FixHits}`);
console.log(`text/desc hits:   ${textHits}`);
console.log(`hostname hits:    ${hostHits}`);
console.log(`Total new labels: ${re3FixHits + textHits + hostHits}`);
