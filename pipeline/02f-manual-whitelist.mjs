#!/usr/bin/env node
// Apply a hand-curated whitelist of clients running known custom or institutional
// infrastructure. These are not detection failures — they are bespoke codebases
// (NIFS, DiSSCo, GBIF, arXiv, DSMZ family, etc.) that legitimately have no
// public software label. Promoting them out of "unknown" makes the unidentified
// bucket more honest.
//
// Source: data/manual-whitelist.json (committed; freely editable).
// Output: in-place update of data/clients.enriched.json with softwareSource: "manual".

import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");
const FILE = join(DATA, "clients.enriched.json");
const WHITELIST = join(DATA, "manual-whitelist.json");

if (!existsSync(WHITELIST)) {
  console.error(`Missing ${WHITELIST}. Nothing to apply.`);
  process.exit(0);
}

const clients = JSON.parse(readFileSync(FILE, "utf8"));
const wl = JSON.parse(readFileSync(WHITELIST, "utf8"));

function hostnameOf(url) {
  try {
    if (!url) return null;
    const u = url.startsWith("http") ? url : `https://${url}`;
    return new URL(u).hostname.toLowerCase();
  } catch { return null; }
}

function lookup(c) {
  // 1. Exact client id
  if (wl.byClientId?.[c.id]) return wl.byClientId[c.id];
  // 2. Prefix match (client id starts with key)
  for (const [prefix, entry] of Object.entries(wl.byClientPrefix || {})) {
    if (c.id.startsWith(prefix)) return entry;
  }
  // 3. Hostname matches
  const host = hostnameOf(c.url);
  if (host) {
    if (wl.byHostname?.[host]) return wl.byHostname[host];
    for (const [suffix, entry] of Object.entries(wl.byHostnameSuffix || {})) {
      const suf = suffix.startsWith(".") ? suffix : `.${suffix}`;
      if (host === suffix.replace(/^\./, "") || host.endsWith(suf)) return entry;
    }
  }
  return null;
}

let hits = 0;
const overrides = [];
for (const c of clients) {
  const entry = lookup(c);
  if (!entry) continue;
  // Whitelist always wins, even over earlier detection — because the human
  // curator's intent is usually to correct a misleading or stale label.
  if (c.softwareDetected && c.softwareDetected !== entry.platform) {
    overrides.push({ id: c.id, was: c.softwareDetected, becomes: entry.platform });
  }
  c.softwareDetected = entry.platform;
  c.softwareSource = "manual";
  c.manualNote = entry.note || null;
  hits++;
}

writeFileSync(FILE, JSON.stringify(clients, null, 2));
console.log(`Manual whitelist applied to ${hits} clients.`);
if (overrides.length) {
  console.log(`  ${overrides.length} overrides of prior labels:`);
  for (const o of overrides) console.log(`    ${o.id}: ${o.was} → ${o.becomes}`);
}
