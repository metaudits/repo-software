#!/usr/bin/env node
// Match unknown clients against the re3data registry by NAME (not DOI).
// Many institutional repositories are listed in re3data with software set,
// but their DataCite client record doesn't carry a re3data DOI back-pointer.
// Strategy:
//   1. Download (or reuse cached) full re3data list — name + repo id.
//   2. Build a normalized-name index.
//   3. For each unknown client with a name, look it up in the index.
//   4. For matches, fetch the re3data detail XML (cached) and extract
//      <r3d:softwareName>.
// Output: in-place update of clients.enriched.json. softwareSource: "re3data-name".

import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { fetchText, mapConcurrent } from "./lib/http.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");
const FILE = join(DATA, "clients.enriched.json");
const NAME_INDEX_FILE = join(DATA, "re3data-name-index.json");
const DETAIL_CACHE_FILE = join(DATA, "re3data-software.json");

const clients = JSON.parse(readFileSync(FILE, "utf8"));
const detailCache = existsSync(DETAIL_CACHE_FILE) ? JSON.parse(readFileSync(DETAIL_CACHE_FILE, "utf8")) : {};

function normalize(s) {
  if (!s) return "";
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|a|an|of|for|and|in|at|on|de|la|el|los|las|du|des|le)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Build / load name index
let nameIndex;
if (existsSync(NAME_INDEX_FILE)) {
  nameIndex = JSON.parse(readFileSync(NAME_INDEX_FILE, "utf8"));
  console.log(`Loaded cached re3data name index (${Object.keys(nameIndex).length} entries).`);
} else {
  console.log("Fetching full re3data repository list...");
  const { text, status } = await fetchText("https://www.re3data.org/api/v1/repositories", { timeoutMs: 60000 });
  if (status !== 200) {
    console.error(`re3data list fetch failed: HTTP ${status}`);
    process.exit(1);
  }
  nameIndex = {};
  const re = /<id>\s*(r3d[0-9]+)\s*<\/id>\s*<doi>[^<]+<\/doi>\s*<name>\s*([^<]+?)\s*<\/name>/gs;
  let m;
  while ((m = re.exec(text)) !== null) {
    const id = m[1].trim();
    const name = normalize(m[2]);
    if (name) nameIndex[name] = id;
  }
  writeFileSync(NAME_INDEX_FILE, JSON.stringify(nameIndex, null, 2));
  console.log(`  indexed ${Object.keys(nameIndex).length} repos by name.`);
}

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

// Candidates: unknown clients with a name
const candidates = clients
  .map((c, i) => ({ idx: i, c }))
  .filter(({ c }) => !c.softwareDetected && c.name);

let exactHits = 0;
let detailFetches = 0;
const lookups = [];
for (const { idx, c } of candidates) {
  const key = normalize(c.name);
  const re3id = nameIndex[key];
  if (re3id) {
    exactHits++;
    lookups.push({ idx, re3id });
  }
}
console.log(`Exact normalized-name matches: ${exactHits}`);

const results = await mapConcurrent(
  lookups,
  async ({ idx, re3id }) => {
    const wasCached = detailCache[re3id] !== undefined;
    if (!wasCached) detailFetches++;
    const sw = await softwareFromRe3data(re3id);
    return { idx, re3id, sw };
  },
  6,
  (d, t) => { if (d % 25 === 0 || d === t) console.log(`  fetching detail ${d}/${t}`); },
);

writeFileSync(DETAIL_CACHE_FILE, JSON.stringify(detailCache, null, 2));

let labelled = 0;
const byPlatform = {};
for (const { idx, re3id, sw } of results) {
  if (sw && !clients[idx].softwareDetected) {
    clients[idx].softwareDetected = sw;
    clients[idx].softwareSource = "re3data-name";
    clients[idx].re3id = re3id;
    labelled++;
    byPlatform[sw] = (byPlatform[sw] || 0) + 1;
  }
}
writeFileSync(FILE, JSON.stringify(clients, null, 2));

console.log("");
console.log(`Detail fetches: ${detailFetches} (rest cached)`);
console.log(`New labels:     ${labelled}`);
console.log("By platform:");
for (const [p, n] of Object.entries(byPlatform).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${p.padEnd(25)} ${n}`);
}
