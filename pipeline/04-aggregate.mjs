#!/usr/bin/env node
// Build dashboard JSONs into web/public/data/.
//   - overview.json      summary counters + software/region/consortium breakdowns
//   - repos.json         flat list of clients (with software + liveness fields)
//   - consortiums.json   consortium roster + their org/client counts
//   - meta.json          generated-at, source notes

import { writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { normalizeSoftware, platformClass } from "./lib/software.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");
const OUT = join(__dirname, "..", "web", "public", "data");
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const file = (n) => join(DATA, n);
const consortiums = JSON.parse(readFileSync(file("consortiums.json"), "utf8"));
const providers   = JSON.parse(readFileSync(file("providers.json"), "utf8"));
// Prefer the most-enriched snapshot we have.
const clientsFile = existsSync(file("clients.live.json")) ? file("clients.live.json")
                 : existsSync(file("clients.enriched.json")) ? file("clients.enriched.json")
                 : file("clients.json");
const clients = JSON.parse(readFileSync(clientsFile, "utf8"));

console.log(`Using ${clientsFile} (${clients.length} clients).`);

function bucketByKey(arr, keyFn, sort = true) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (k == null) continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  let out = [...m.entries()].map(([id, count]) => ({ id, count }));
  if (sort) out.sort((a, b) => b.count - a.count);
  return out;
}

function clientStatus(c) {
  if (c.liveness?.ok) return "alive";
  if (c.liveness?.reason) return c.liveness.reason;
  return "unknown";
}

// Annotate each client with derived fields.
const consortiumByOrg = new Map();
for (const c of consortiums) for (const oid of c.orgIds) consortiumByOrg.set(oid, c.id);
const providerById = new Map(providers.map(p => [p.id, p]));

const annotated = clients.map(c => {
  const sw = normalizeSoftware(c.softwareDetected || c.software);
  const consortiumId = consortiumByOrg.get(c.providerId) || null;
  const prov = providerById.get(c.providerId) || {};
  return {
    id: c.id,
    name: c.name,
    // URL is null-cleared when the upstream value looks like an email — a
    // small number of DataCite clients mistakenly wrote a contact email
    // into the url field; stripping prevents accidental PII redistribution
    // in our CC BY 4.0 derived dataset.
    url: (c.url && /^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/.test(c.url)) ? null : c.url,
    // description intentionally dropped from the published export — DataCite
    // descriptions sometimes include contact emails that the repo maintainers
    // shared with DataCite but didn't expect to see redistributed in derived
    // datasets. Kept in clients.enriched.json (local only) so step 02c can
    // still mine it for platform keywords.
    repositoryType: c.repositoryType || [],
    software: sw,
    softwareClass: sw ? platformClass(sw) : null,
    softwareRaw: c.softwareDetected || c.software || null,
    softwareSource: c.softwareSource || (c.software ? "datacite" : null),
    manualNote: c.manualNote || null,
    re3data: c.re3data || null,
    clientType: c.clientType || null,
    doiCount: typeof c.doiCount === "number" ? c.doiCount : null,
    isActive: c.isActive,
    status: clientStatus(c),
    providerId: c.providerId,
    providerName: prov.name || c.providerId,
    providerCountry: prov.country || null,
    providerRegion: prov.region || null,
    consortiumId,
  };
});

// Per-clientType software histogram (e.g. data repositories vs. journals
// dominate very different platforms — DSpace vs. OJS — so the breakdown
// matters more than the global ranking).
function softwareByClientType(types) {
  const out = {};
  for (const t of types) {
    const subset = annotated.filter(c => c.clientType === t);
    const identified = subset.filter(c => c.software);
    const breakdown = bucketByKey(identified, c => c.software);
    out[t] = {
      total: subset.length,
      identified: identified.length,
      breakdown: breakdown.slice(0, 25),
    };
  }
  return out;
}

const aliveCount  = annotated.filter(c => c.status === "alive").length;
const datacite    = annotated.filter(c => c.softwareSource === "datacite").length;
const re3         = annotated.filter(c => c.softwareSource === "re3data").length;
const heur        = annotated.filter(c => c.softwareSource === "html-detect").length;
const urlPattern  = annotated.filter(c => c.softwareSource === "url-pattern").length;
const nameDesc    = annotated.filter(c => c.softwareSource === "name-desc").length;
const hostMap     = annotated.filter(c => c.softwareSource === "host-map").length;
const oaiPmh      = annotated.filter(c => c.softwareSource === "oai-pmh").length;
const inferred    = annotated.filter(c => c.softwareSource === "inferred-siblings").length;
const manual      = annotated.filter(c => c.softwareSource === "manual").length;
const header      = annotated.filter(c => c.softwareSource === "header").length;
const re3Name     = annotated.filter(c => c.softwareSource === "re3data-name").length;
const doiSample   = annotated.filter(c => c.softwareSource === "doi-sample").length;
const noSoftware  = annotated.filter(c => !c.software).length;
const activeClients = annotated.filter(c => (c.doiCount || 0) > 0).length;
const totalDois   = annotated.reduce((s, c) => s + (c.doiCount || 0), 0);

const overview = {
  generatedAt: new Date().toISOString(),
  source: "https://api.datacite.org/providers?member-type=consortium",
  totals: {
    consortiums: consortiums.length,
    memberOrgs: providers.length,
    clients: annotated.length,
    activeClients,
    inactiveClients: annotated.length - activeClients,
    totalDois,
    alive: aliveCount,
    aliveRate: annotated.length ? aliveCount / annotated.length : 0,
    withSoftware: annotated.length - noSoftware,
    withoutSoftware: noSoftware,
  },
  softwareSources: {
    datacite, re3data: re3, re3Name, htmlDetect: heur, urlPattern, nameDesc, hostMap, oaiPmh, inferred, manual, header, doiSample, missing: noSoftware,
  },
  softwareBreakdown: bucketByKey(annotated, c => c.software),
  repositoryTypes: bucketByKey(annotated.flatMap(c => c.repositoryType.map(t => t || null))),
  byRegion: bucketByKey(annotated, c => c.providerRegion),
  byCountry: bucketByKey(annotated, c => c.providerCountry).slice(0, 30),
  byStatus: bucketByKey(annotated, c => c.status),
  byClientType: bucketByKey(annotated, c => c.clientType),
  softwareByClientType: softwareByClientType(["repository", "periodical", "igsnCatalog", "raidRegistry"]),
  topSoftwareAlive: (() => {
    const m = new Map();
    for (const c of annotated) {
      if (!c.software) continue;
      const key = c.software;
      const v = m.get(key) || { id: key, total: 0, alive: 0 };
      v.total++;
      if (c.status === "alive") v.alive++;
      m.set(key, v);
    }
    return [...m.values()].sort((a, b) => b.total - a.total);
  })(),
};

writeFileSync(join(OUT, "overview.json"), JSON.stringify(overview, null, 2));
writeFileSync(join(OUT, "repos.json"), JSON.stringify(annotated, null, 2));

// Consortium roster with rollups + per-consortium software histogram so the
// dashboard can render a stacked platform-mix bar (the natural pair to Ted
// Habermann's per-consortium completeness boxplots — same x-axis, complementary
// y-axis: "which platforms produce the metadata you're auditing").
const consortiumRoster = consortiums.map(c => {
  const orgIds = new Set(c.orgIds);
  const cClients = annotated.filter(x => orgIds.has(x.providerId));
  const swSet = new Set(cClients.map(x => x.software).filter(Boolean));
  const swHist = bucketByKey(cClients, x => x.software || "(unidentified)");
  const repoCount = cClients.filter(x => x.clientType === "repository").length;
  const periodicalCount = cClients.filter(x => x.clientType === "periodical").length;
  const dominant = swHist.find(s => s.id !== "(unidentified)");
  const identifiedCount = cClients.filter(x => x.software).length;
  // Two homogeneity scores: against total (incl. unidentified) and against the
  // identified slice. The latter is the more meaningful "of what we can see,
  // how concentrated is it" — used as the bright-spot signal in the dashboard.
  const homogeneity = cClients.length && dominant ? dominant.count / cClients.length : 0;
  const homogeneityIdentified = identifiedCount && dominant ? dominant.count / identifiedCount : 0;
  return {
    id: c.id,
    name: c.name,
    displayName: c.displayName,
    country: c.country,
    region: c.region,
    rorId: c.rorId,
    organizationType: c.organizationType,
    focusArea: c.focusArea,
    isActive: c.isActive,
    joined: c.joined,
    orgCount: c.orgIds.length,
    clientCount: cClients.length,
    repoCount,
    periodicalCount,
    aliveCount: cClients.filter(x => x.status === "alive").length,
    distinctSoftware: swSet.size,
    softwareList: [...swSet].sort(),
    softwareHistogram: swHist,                  // [{id, count}, …, "(unidentified)"]
    dominantSoftware: dominant?.id || null,
    identifiedCount,
    homogeneity,                                 // dominant_count / total_clients
    homogeneityIdentified,                       // dominant_count / identified_clients
  };
}).sort((a, b) => b.clientCount - a.clientCount);

writeFileSync(join(OUT, "consortiums.json"), JSON.stringify(consortiumRoster, null, 2));

// Copy completeness samples (produced by pipeline/05) into the dashboard data dir
// so the Habermann tab can load it without a separate cp step.
const COMPL_SRC = join(DATA, "completeness-samples.json");
if (existsSync(COMPL_SRC)) {
  const content = readFileSync(COMPL_SRC, "utf8");
  writeFileSync(join(OUT, "completeness-samples.json"), content);
  console.log(`  copied completeness-samples.json (${(content.length / 1024).toFixed(1)} KB)`);
}

// Snapshot integrity: mtime of each upstream pipeline file. Surface this in the
// dashboard so a reader sees that, e.g., the consortium roster is 3 days older
// than the aggregate run. Reviewers will ask.
function freshness(label, path) {
  if (!existsSync(path)) return { label, exists: false };
  const s = statSync(path);
  return {
    label,
    path: path.replace(__dirname.replace(/pipeline$/, ""), ""),
    sizeBytes: s.size,
    mtime: s.mtime.toISOString(),
  };
}
const upstream = [
  freshness("consortiums (00-fetch-consortiums)",  file("consortiums.json")),
  freshness("providers (01-fetch-clients)",         file("providers.json")),
  freshness("clients raw (01-fetch-clients)",       file("clients.json")),
  freshness("clients enriched (02-enrich-software etc.)", file("clients.enriched.json")),
  freshness("liveness probe (03-liveness)",         file("liveness-cache.json")),
  freshness("doi counts (03b-doi-counts)",          file("doi-counts.json")),
  freshness("completeness sample (05-completeness)", file("completeness-samples.json")),
  freshness("completeness cache (05-completeness)",  file("completeness-cache.json")),
  freshness("field counts (06-field-counts)",       file("field-counts-cache.json")),
];

writeFileSync(join(OUT, "meta.json"), JSON.stringify({
  generatedAt: overview.generatedAt,
  source: overview.source,
  files: ["overview.json", "repos.json", "consortiums.json", "completeness-samples.json"],
  upstream,
}, null, 2));

console.log(`Aggregated → ${OUT}`);
console.log(`  consortiums: ${consortiums.length}`);
console.log(`  member orgs: ${providers.length}`);
console.log(`  clients:     ${annotated.length}`);
console.log(`  alive:       ${aliveCount}`);
console.log(`  software ID: ${annotated.length - noSoftware} / ${annotated.length} (${((annotated.length - noSoftware) / annotated.length * 100).toFixed(1)}%)`);
