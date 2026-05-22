#!/usr/bin/env node
// Liveness + header-based detection.
//   • GET each client URL (10 s timeout, redirects followed).
//   • Record alive / dead / timeout / network-error.
//   • Capture Server, X-Powered-By, X-Generator, Set-Cookie hints.
//   • For clients still without software label, try to derive one from those
//     headers (last resort — mostly catches Drupal sites via X-Generator).
// Output: in-place update of data/clients.enriched.json.

import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mapConcurrent } from "./lib/http.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");
const FILE = join(DATA, "clients.enriched.json");
const CACHE_FILE = join(DATA, "liveness-cache.json");
const clients = JSON.parse(readFileSync(FILE, "utf8"));
const cache = existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, "utf8")) : {};

const UA = "repo-software-audit (+https://metaudits.rijdho.org)";

const HEADER_SIGNATURES = [
  { name: "Drupal",       re: /Drupal/i,           headers: ["x-generator", "x-powered-by"] },
  { name: "WordPress",    re: /WordPress/i,        headers: ["x-generator", "x-powered-by"] },
  { name: "DSpace",       re: /DSpace/i,           headers: ["server", "x-powered-by"] },
  { name: "Dataverse",    re: /Dataverse/i,        headers: ["server", "x-generator"] },
  { name: "Invenio",      re: /Invenio/i,          headers: ["server", "x-generator"] },
  { name: "EPrints",      re: /EPrints/i,          headers: ["server", "x-generator"] },
];

function detectFromHeaders(headers) {
  if (!headers) return null;
  for (const sig of HEADER_SIGNATURES) {
    for (const hkey of sig.headers) {
      const v = headers[hkey];
      if (v && sig.re.test(v)) return sig.name;
    }
  }
  return null;
}

async function probe(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": UA, Accept: "text/html,*/*" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    clearTimeout(t);
    const headers = {};
    for (const [k, v] of res.headers.entries()) headers[k.toLowerCase()] = v;
    // Don't read the body — we already did that in step 02.
    return { status: res.status, ok: res.ok, finalUrl: res.url, headers };
  } catch (e) {
    clearTimeout(t);
    return { status: 0, ok: false, error: String(e?.name || e) };
  }
}

let probeCount = 0;
const enriched = await mapConcurrent(
  clients,
  async (c) => {
    if (!c.url) return { ...c, liveness: { status: null, ok: null, reason: "no-url" } };
    let r;
    if (cache[c.id]) r = cache[c.id];
    else {
      r = await probe(c.url);
      cache[c.id] = r;
      probeCount++;
      if (probeCount % 200 === 0) writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    }
    let reason = "alive";
    if (r.error) reason = "network-error";
    else if (r.status === 0) reason = "timeout";
    else if (r.status >= 400) reason = `http-${r.status}`;
    else if (!r.ok) reason = `http-${r.status}`;
    const liveness = { status: r.status, ok: r.ok, finalUrl: r.finalUrl || c.url, reason };

    // Last-resort detection via headers, only if we still don't have a label.
    let out = { ...c, liveness };
    if (!c.softwareDetected && r.headers) {
      const sw = detectFromHeaders(r.headers);
      if (sw) {
        out.softwareDetected = sw;
        out.softwareSource = "header";
      }
    }
    return out;
  },
  12,
  (d, t) => { if (d % 200 === 0 || d === t) console.log(`  probing ${d}/${t}`); },
);

writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
writeFileSync(FILE, JSON.stringify(enriched, null, 2));

const alive  = enriched.filter(c => c.liveness?.ok).length;
const dead   = enriched.filter(c => c.liveness?.reason && c.liveness.reason !== "alive" && c.liveness.reason !== "no-url").length;
const noUrl  = enriched.filter(c => c.liveness?.reason === "no-url").length;
const headerHits = enriched.filter(c => c.softwareSource === "header").length;

console.log("");
console.log(`Alive:           ${alive}`);
console.log(`Dead / errored:  ${dead}`);
console.log(`No URL:          ${noUrl}`);
console.log(`Header-detect:   ${headerHits}`);
console.log(`Updated data/clients.enriched.json + data/liveness-cache.json`);
