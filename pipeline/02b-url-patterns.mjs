#!/usr/bin/env node
// Patch step: detect repository software by URL pattern, in-memory only.
// Runs AFTER 02-enrich-software.mjs. Looks at clients with no software label
// yet and matches their URL against a library of strong path/hostname signatures.
// No HTTP calls — pure CPU.

import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");
const FILE = join(DATA, "clients.enriched.json");
if (!existsSync(FILE)) {
  console.error("Missing data/clients.enriched.json — run pipeline:enrich first.");
  process.exit(1);
}
const clients = JSON.parse(readFileSync(FILE, "utf8"));

// URL pattern → platform. Order matters — first match wins.
// Patterns are intentionally specific so we don't false-positive on "/data/" or "/journal/".
const URL_PATTERNS = [
  // DSpace
  { name: "DSpace",       re: /\/(handle|jspui|xmlui|dspace)\//i },
  { name: "DSpace",       re: /\/server\/api\/discover/i },
  { name: "DSpace",       re: /(^|\.)dspace\./i },
  // Dataverse
  { name: "Dataverse",    re: /(^|\.)dataverse\./i },
  { name: "Dataverse",    re: /\/(dataverse|dvn)\//i },
  // Zenodo / InvenioRDM
  { name: "Zenodo",       re: /(^|\.)zenodo\./i },
  { name: "InvenioRDM",   re: /(^|\.)inveniordm\.|\/invenio-rdm/i },
  { name: "Invenio",      re: /(^|\.)invenio\.|\/invenio/i },
  // EPrints
  { name: "EPrints",      re: /(^|\.)eprints\.|\/eprints?\//i },
  { name: "EPrints",      re: /\/cgi\/(viewcontent|export|search|stats|register)/i },
  // Figshare
  { name: "Figshare",     re: /(^|\.)figshare\./i },
  // CKAN
  { name: "CKAN",         re: /(^|\.)ckan\.|\/ckan\//i },
  { name: "CKAN",         re: /\/dataset\/[\w-]+\?id=/i },
  // OJS — strong when index.php and journal-y hostname/path
  { name: "OJS",          re: /(revistas|revistes|revues|periodicos|periódicos|journals?|publicaciones|publications)\.[^\/]+\/index\.php\//i },
  { name: "OJS",          re: /\/ojs\/|\/index\.php\/[\w-]+(?:\/(?:issue|article|index|about|search))/i },
  // Samvera / Hyrax
  { name: "Samvera/Hyrax", re: /\/(catalog|concern\/works)\/[a-z0-9]{8,}/i },
  // Islandora
  { name: "Islandora",    re: /\/islandora\/object\//i },
  // Drupal admin paths (last resort)
  { name: "Drupal",       re: /\/node\/\d+|\/sites\/default\/files\//i },
  // MediaWiki
  { name: "MediaWiki",    re: /\/wiki\/(?:Main_Page|Special:)/i },
  // GeoNetwork (geo catalogs — common for igsnCatalog clients)
  { name: "GeoNetwork",   re: /\/(geonetwork|catalog)\/srv\//i },
  // OPUS (German uni repos)
  { name: "OPUS",         re: /\/opus[345]?\//i },
];

function isHttpUrl(u) {
  if (!u || typeof u !== "string") return false;
  if (u.includes("@") && !u.startsWith("http")) return false;   // skip emails
  return /^https?:\/\//i.test(u) || /^[a-z0-9.-]+\.[a-z]{2,}/i.test(u);
}

function normalizeUrl(u) {
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  if (/^[a-z0-9.-]+\.[a-z]{2,}/i.test(u)) return `https://${u}`;
  return null;
}

function detectFromUrl(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) return null;
  for (const p of URL_PATTERNS) {
    if (p.re.test(url)) return p.name;
  }
  return null;
}

let hits = 0;
let scanned = 0;
const out = clients.map(c => {
  if (c.softwareDetected) return c;                 // already labeled
  if (!isHttpUrl(c.url)) return c;
  scanned++;
  const sw = detectFromUrl(c.url);
  if (!sw) return c;
  hits++;
  return { ...c, softwareSource: "url-pattern", softwareDetected: sw };
});

writeFileSync(FILE, JSON.stringify(out, null, 2));
console.log(`Scanned ${scanned} URL-only unknowns. URL-pattern hits: ${hits}.`);
console.log(`Updated data/clients.enriched.json.`);

// Breakdown by detected platform
const byPlatform = {};
for (const c of out) {
  if (c.softwareSource === "url-pattern") byPlatform[c.softwareDetected] = (byPlatform[c.softwareDetected] || 0) + 1;
}
console.log("\nURL-pattern detections:");
for (const [k, v] of Object.entries(byPlatform).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(20)} ${v}`);
}
