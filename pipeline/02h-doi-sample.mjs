#!/usr/bin/env node
// Sample one real DOI per unidentified client and inspect its landing page.
// Many DataCite clients have no `url` attribute at the client level, but every
// DOI they mint has a `url` (landing page) — which is often the most diagnostic
// signal we can get. Strategy:
//   1. For each unknown client with at least 1 DOI, fetch /dois?client-id=X&page[size]=1
//   2. Read data[0].attributes.url — the landing page
//   3. Apply URL-pattern detection (including new bepress / Digital Commons rules)
//   4. If no URL-pattern hit, GET the landing page and run HTML signature scan
// Cache: data/doi-sample-cache.json keyed by client id.

import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { fetchJson, fetchText, mapConcurrent } from "./lib/http.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");
const FILE = join(DATA, "clients.enriched.json");
const CACHE_FILE = join(DATA, "doi-sample-cache.json");
const clients = JSON.parse(readFileSync(FILE, "utf8"));
const cache = existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, "utf8")) : {};

// URL patterns (path or hostname). First match wins.
const URL_PATTERNS = [
  // bepress / Digital Commons — extremely common in US universities
  { name: "bepress / Digital Commons", re: /\/cgi\/viewcontent\.cgi\?article=/i },
  { name: "bepress / Digital Commons", re: /\/(theses|etd|dissertations|honors|capstones|undergraduate_research|conference|fac_pubs|conf_proc)\/[0-9]+\/?/i },
  // DSpace
  { name: "DSpace",       re: /\/(handle|jspui|xmlui)\//i },
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
  { name: "EPrints",      re: /\/cgi\/(export|stats|register|users)/i },
  // Figshare
  { name: "Figshare",     re: /(^|\.)figshare\./i },
  // CKAN
  { name: "CKAN",         re: /(^|\.)ckan\.|\/ckan\//i },
  // OJS — index.php + journal-style route
  { name: "OJS",          re: /(revistas|revistes|revues|periodicos|periódicos|journals?|publicaciones|publications)\.[^\/]+\/index\.php\//i },
  { name: "OJS",          re: /\/ojs\/|\/index\.php\/[\w-]+\/(?:issue|article|index|about|search)/i },
  // Samvera/Hyrax
  { name: "Samvera/Hyrax", re: /\/(catalog|concern\/works)\/[a-z0-9]{8,}/i },
  // Islandora
  { name: "Islandora",    re: /\/islandora\/object\//i },
  // MediaWiki
  { name: "MediaWiki",    re: /\/wiki\/(?:Main_Page|Special:)/i },
  // GeoNetwork
  { name: "GeoNetwork",   re: /\/(geonetwork|catalog)\/srv\//i },
  // OPUS
  { name: "OPUS",         re: /\/opus[345]?\//i },
];

const HTML_SIGS = [
  // bepress
  { name: "bepress / Digital Commons", re: /Digital Commons Network|bepress|<a[^>]+href=["'][^"']*\/aboutbepress\.html|<img[^>]+src=["'][^"']*\/bepress-logo/i },
  { name: "DSpace",        re: /<meta[^>]+name=["']generator["'][^>]+content=["'][^"']*DSpace|Powered\s+by\s+DSpace|DSpace\s+(?:7|6|software|repository)/i },
  { name: "Dataverse",     re: /<meta[^>]+name=["']generator["'][^>]+content=["'][^"']*Dataverse|Powered\s+by\s+Dataverse|dataverse\.org/i },
  { name: "EPrints",       re: /<meta[^>]+name=["']generator["'][^>]+content=["'][^"']*EPrints|Powered\s+by\s+EPrints|eprints\.org/i },
  { name: "InvenioRDM",    re: /InvenioRDM|invenio-rdm/i },
  { name: "Invenio",       re: /<meta[^>]+name=["']generator["'][^>]+content=["'][^"']*Invenio|Powered\s+by\s+Invenio/i },
  { name: "Zenodo",        re: /Zenodo\s+is\s+(?:developed|operated)/i },
  { name: "CKAN",          re: /<meta[^>]+name=["']generator["'][^>]+content=["'][^"']*CKAN|Powered\s+by\s+CKAN/i },
  { name: "OJS",           re: /Open Journal Systems|<meta[^>]+content=["']OJS\s+[0-9]/i },
  { name: "Drupal",        re: /<meta[^>]+name=["']generator["'][^>]+content=["'][^"']*Drupal/i },
  { name: "WordPress",     re: /<meta[^>]+name=["']generator["'][^>]+content=["'][^"']*WordPress/i },
  { name: "Samvera/Hyrax", re: /Hyrax|Samvera/i },
  { name: "Fedora",        re: /Fedora Commons|fcrepo/i },
  { name: "Islandora",     re: /Islandora/i },
  { name: "Figshare",      re: /figshare\.com/i },
];

function detectUrl(url) {
  if (!url) return null;
  for (const p of URL_PATTERNS) if (p.re.test(url)) return p.name;
  return null;
}

function detectHtml(html) {
  if (!html) return null;
  const slice = html.slice(0, 200000);
  for (const s of HTML_SIGS) if (s.re.test(slice)) return s.name;
  return null;
}

const candidates = clients
  .map((c, i) => ({ idx: i, c }))
  .filter(({ c }) => !c.softwareDetected && (c.doiCount || 0) > 0);

console.log(`DOI-sample target: ${candidates.length} unknowns with ≥1 DOI`);
console.log(`Cached entries:    ${Object.keys(cache).length}`);

async function sampleAndDetect(clientId) {
  if (cache[clientId] !== undefined) return cache[clientId];
  // Fetch one DOI for this client
  let landing = null;
  try {
    const r = await fetchJson(`https://api.datacite.org/dois?client-id=${encodeURIComponent(clientId)}&page[size]=1`, { retries: 3 });
    landing = r?.data?.[0]?.attributes?.url || null;
  } catch { /* swallow */ }
  if (!landing) {
    cache[clientId] = { landing: null, software: null, via: null };
    return cache[clientId];
  }
  // 1. URL pattern
  let sw = detectUrl(landing);
  let via = sw ? "url" : null;
  // 2. HTML probe
  if (!sw) {
    try {
      const { text } = await fetchText(landing, { timeoutMs: 10000, retries: 1 });
      sw = detectHtml(text);
      if (sw) via = "html";
    } catch { /* swallow */ }
  }
  cache[clientId] = { landing, software: sw, via };
  return cache[clientId];
}

let i = 0;
const results = await mapConcurrent(
  candidates.map(c => c.c.id),
  async (id) => sampleAndDetect(id),
  4,
  (d, t) => {
    if (d % 100 === 0 || d === t) {
      console.log(`  sampling ${d}/${t}`);
      writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    }
  },
);

writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));

let hits = 0;
const byPlatform = {};
for (let k = 0; k < candidates.length; k++) {
  const { idx } = candidates[k];
  const r = results[k];
  if (r?.software && !clients[idx].softwareDetected) {
    clients[idx].softwareDetected = r.software;
    clients[idx].softwareSource = "doi-sample";
    clients[idx].sampledUrl = r.landing;
    hits++;
    byPlatform[r.software] = (byPlatform[r.software] || 0) + 1;
  }
}
writeFileSync(FILE, JSON.stringify(clients, null, 2));

console.log("");
console.log(`Hits: ${hits}`);
for (const [p, n] of Object.entries(byPlatform).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${p.padEnd(28)} ${n}`);
}
console.log(`Updated data/clients.enriched.json + data/doi-sample-cache.json`);
