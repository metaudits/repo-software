#!/usr/bin/env node
// Per-client + per-platform metadata completeness on the 12 Habermann-aligned
// fields. Two data sources, in priority order:
//
//   1. field-counts-cache.json  (produced by 06-field-counts.mjs) — for each
//      client, the EXACT count of DOIs in which each of the 12 fields is
//      populated, divided by the client's total DOI count. No sampling.
//
//   2. completeness-cache.json  (legacy 3-DOI sample) — fallback for clients
//      we haven't yet field-counted. Each per-field rate is over at most 3
//      DOIs (small-sample, noisy, recency-biased — see paper/outline.md).
//
// Per-client rate = mean across the 12 fields. Per-platform stats = mean,
// median, IQR, 95% CI computed ACROSS clients running that platform. The
// repository slice also carries Δ-vs-DSpace pre-computed.
//
// Output: data/completeness-samples.json — schema unchanged, plus a new
// `sources` block describing how many clients in each slice came from the
// population (field-counts) vs the 3-DOI sample.

import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { normalizeSoftware, platformClass } from "./lib/software.mjs";
import { tInv975, welchDF } from "./lib/stats.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");
const FILE = join(DATA, "clients.enriched.json");
const OUT = join(DATA, "completeness-samples.json");
const SAMPLE_CACHE = join(DATA, "completeness-cache.json");
const FIELD_CACHE  = join(DATA, "field-counts-cache.json");

const clients = JSON.parse(readFileSync(FILE, "utf8"));
const sampleCache = existsSync(SAMPLE_CACHE) ? JSON.parse(readFileSync(SAMPLE_CACHE, "utf8")) : {};
const fieldCache  = existsSync(FIELD_CACHE)  ? JSON.parse(readFileSync(FIELD_CACHE,  "utf8")) : {};

// 12 fields, in the exact use-case-grouped order expected by the dashboard.
const USE_CASES = {
  Text:        ["titles", "descriptions", "subjects"],
  Identifiers: ["relatedIdentifiers", "alternateIdentifiers", "version"],
  Connections: ["fundingReferences", "container", "geoLocations"],
  Contacts:    ["creators", "creatorOrcid", "contributors"],
};
const FIELDS = Object.values(USE_CASES).flat();

// Per-client: returns { source, mean, byField, dois } where `source` ∈
// {"population","sample","none"}. byField is a fraction in [0,1] per field.
function clientRates(clientId) {
  const fc = fieldCache[clientId];
  if (fc?.complete && fc.total > 0 && fc.byField) {
    const byField = {};
    for (const f of FIELDS) {
      const n = fc.byField[f];
      byField[f] = typeof n === "number" && fc.total > 0 ? n / fc.total : 0;
    }
    const mean = FIELDS.reduce((s, f) => s + byField[f], 0) / FIELDS.length;
    return { source: "population", mean, byField, dois: fc.total };
  }
  const sc = sampleCache[clientId];
  if (sc?.mean != null && sc.byField) {
    return { source: "sample", mean: sc.mean, byField: sc.byField, dois: sc.n };
  }
  return { source: "none", mean: null, byField: null, dois: 0 };
}

const candidates = clients.filter(c => c.softwareDetected && (c.doiCount || 0) > 0);
const sampled = [];
const perClient = {};
for (const c of candidates) {
  const r = clientRates(c.id);
  perClient[c.id] = r;
  if (r.mean == null) continue;
  const sw = normalizeSoftware(c.softwareDetected);
  if (!sw) continue;
  sampled.push({
    clientId: c.id,
    software: sw,
    softwareClass: platformClass(sw),
    clientType: c.clientType || null,
    mean: r.mean,
    n: r.dois,
    byField: r.byField,
    source: r.source,
  });
}

function quantile(arr, q) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function statsFor(samples, byFieldArrays) {
  if (samples.length === 0) return null;
  const n = samples.length;
  const mean = samples.reduce((a, x) => a + x, 0) / n;
  const variance = n > 1
    ? samples.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)
    : 0;
  const sd = Math.sqrt(variance);
  const se = sd / Math.sqrt(n);
  // t-distribution critical value (df = n-1) instead of the fixed 1.96. For
  // n≥30 this collapses to 1.96; for n=3 it's ~4.30, so the wide-CI honesty
  // shows up where the data is actually sparse.
  const tCrit = tInv975(n - 1);
  const ci95 = tCrit * se;
  return {
    clients: n,
    mean, sd, se,
    tCritical: tCrit,
    ci95Lower: Math.max(0, mean - ci95),
    ci95Upper: Math.min(1, mean + ci95),
    median: quantile(samples, 0.5),
    p25:    quantile(samples, 0.25),
    p75:    quantile(samples, 0.75),
    min:    Math.min(...samples),
    max:    Math.max(...samples),
    byField: byFieldArrays
      ? Object.fromEntries(
          Object.entries(byFieldArrays).map(([f, vs]) => [f, vs.reduce((a, x) => a + x, 0) / vs.length])
        )
      : null,
  };
}

function aggregateByPlatform(records) {
  const byPlatform = new Map();
  for (const r of records) {
    if (!byPlatform.has(r.software)) {
      byPlatform.set(r.software, { samples: [], byField: {}, doisCovered: 0, populationN: 0, sampleN: 0 });
    }
    const b = byPlatform.get(r.software);
    b.samples.push(r.mean);
    b.doisCovered += r.n;
    if (r.source === "population") b.populationN++;
    else if (r.source === "sample") b.sampleN++;
    for (const [f, v] of Object.entries(r.byField || {})) {
      if (!b.byField[f]) b.byField[f] = [];
      b.byField[f].push(v);
    }
  }
  const out = [];
  for (const [sw, b] of byPlatform.entries()) {
    if (b.samples.length < 3) continue;
    const stats = statsFor(b.samples, b.byField);
    out.push({
      software: sw,
      softwareClass: platformClass(sw),
      doisCovered: b.doisCovered,        // total DOIs represented (across pop + sample mix)
      populationClients: b.populationN,  // # clients with full-population rates
      sampleClients: b.sampleN,          // # clients still on 3-DOI fallback
      ...stats,
    });
  }
  out.sort((a, b) => b.clients - a.clients);
  return out;
}

const clientTypes = ["repository", "periodical", "igsnCatalog", "raidRegistry"];
const platformStatsByType = {};
for (const t of clientTypes) {
  platformStatsByType[t] = aggregateByPlatform(sampled.filter(r => r.clientType === t));
}
const platformStats = aggregateByPlatform(sampled);

function attachDeltaVsBaseline(stats, baseline) {
  const base = stats.find(s => s.software === baseline);
  if (!base) return stats;
  return stats.map(s => {
    const seDiff = Math.sqrt((s.se ** 2) + (base.se ** 2));
    // Welch-Satterthwaite df for the difference of independent means — so a
    // small-n platform vs large-n DSpace gets honest small-sample df, not
    // overstated power from pretending n=∞.
    const dfDiff = welchDF(s.se, s.clients, base.se, base.clients);
    const tCritDiff = tInv975(dfDiff);
    return {
      ...s,
      deltaVsBaseline: s.mean - base.mean,
      deltaVsBaselineSE: seDiff,
      deltaVsBaselineDF: dfDiff,
      deltaVsBaselineTCrit: tCritDiff,
      deltaVsBaselineCI95: tCritDiff * seDiff,
    };
  });
}
platformStatsByType.repository = attachDeltaVsBaseline(platformStatsByType.repository, "DSpace");

const sources = {
  population: sampled.filter(r => r.source === "population").length,
  sample:     sampled.filter(r => r.source === "sample").length,
  totalClients: sampled.length,
  totalDoisCovered: sampled.reduce((s, r) => s + (r.source === "population" ? r.n : 0), 0),
};

writeFileSync(OUT, JSON.stringify({
  generatedAt: new Date().toISOString(),
  totalClientsSampled: candidates.length,
  totalClientsWithData: sampled.length,
  fields: FIELDS,
  useCases: USE_CASES,
  sources,
  perClient,
  platformStats,
  platformStatsByType,
}, null, 2));

console.log("");
console.log(`Wrote ${OUT}`);
console.log(`Source mix: ${sources.population} clients on population rates (${(sources.totalDoisCovered/1e6).toFixed(1)}M DOIs covered) · ${sources.sample} on 3-DOI sample fallback`);
console.log("");
console.log("Repository-software clients only (clientType=repository), n≥3 — t-distribution CIs:");
console.log(`${"platform".padEnd(28)} ${"clients".padStart(8)} ${"mean".padStart(8)} ${"95% CI (t)".padStart(15)} ${"vs DSpace".padStart(12)} ${"Δ CI".padStart(12)} ${"src".padStart(14)}`);
for (const p of platformStatsByType.repository.slice(0, 25)) {
  const meanS  = (p.mean * 100).toFixed(1) + "%";
  const ciS    = `±${((p.tCritical ?? 1.96) * p.se * 100).toFixed(1)}pp`;
  const deltaS = p.deltaVsBaseline != null
    ? `${(p.deltaVsBaseline * 100 >= 0 ? "+" : "")}${(p.deltaVsBaseline * 100).toFixed(1)}pp`
    : "—";
  const deltaCI = p.deltaVsBaselineCI95 != null
    ? `±${(p.deltaVsBaselineCI95 * 100).toFixed(1)}pp`
    : "—";
  const srcS   = `${p.populationClients}p/${p.sampleClients}s`;
  console.log(`${p.software.padEnd(28)} ${String(p.clients).padStart(8)} ${meanS.padStart(7)} ${ciS.padStart(14)} ${deltaS.padStart(12)} ${deltaCI.padStart(12)} ${srcS.padStart(14)}`);
}
