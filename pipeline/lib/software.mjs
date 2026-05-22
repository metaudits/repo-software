// Shared software-label normalization + platform-class taxonomy.
// Used by both 04-aggregate (annotating clients) and 05-completeness
// (per-platform stats) so both views collapse the same case variants.

export function normalizeSoftware(s) {
  if (!s) return null;
  const t = String(s).trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  // Repository platforms
  if (lower.includes("dspace")) return "DSpace";
  if (lower.includes("dataverse")) return "Dataverse";
  if (lower.includes("eprints")) return "EPrints";
  if (lower.includes("inveniordm")) return "InvenioRDM";
  if (lower.includes("invenio")) return "Invenio";
  if (lower === "ckan" || lower.includes("ckan")) return "CKAN";
  if (lower.includes("figshare")) return "Figshare";
  if (lower.includes("hyrax") || lower.includes("samvera")) return "Samvera/Hyrax";
  if (lower.includes("fedora") || lower.includes("fcrepo")) return "Fedora";
  if (lower.includes("zenodo")) return "Zenodo";
  if (lower.includes("islandora")) return "Islandora";
  if (lower.includes("mycore")) return "MyCoRe";
  if (lower.includes("omeka")) return "Omeka";
  if (lower.includes("opus")) return "OPUS";
  if (lower.includes("bepress") || lower.includes("digital commons")) return "bepress / Digital Commons";
  if (lower.includes("geonetwork")) return "GeoNetwork";
  if (lower.includes("geonode")) return "GeoNode";
  if (lower.includes("tind")) return "TIND";
  if (lower.includes("radar")) return "RADAR";
  if (lower.includes("nesstar")) return "Nesstar";
  if (lower.includes("lodel")) return "Lodel";
  // Journal platforms
  if (lower.includes("ojs") || lower.includes("open journal")) return "OJS";
  // Generic web stacks (kept distinct because they are NOT repository software
  // — they're whatever framework the institution wrapped around its content)
  if (lower.includes("wordpress")) return "WordPress";
  if (lower.includes("drupal")) return "Drupal";
  if (lower === "mysql") return "MySQL";
  // Catch-alls that the detection pipeline emits when it found *something*
  // but can't pin it to a platform family
  if (lower === "other") return "other";
  if (lower === "unknown") return "unknown";
  if (lower.startsWith("custom") || lower.startsWith("institutional")) return "Custom / institutional";
  return t;
}

// Platform classification.
//
// `repository-software-known`   — named/commercial/open-source repository stacks (DSpace, Dataverse, …)
// `repository-software-custom`  — institutional bespoke repository infrastructure that legitimately
//                                  has no public platform label (NIFS, GBIF, arXiv, DSMZ family, …).
//                                  Hand-curated in data/manual-whitelist.json. These ARE repositories
//                                  and should be shown in the headline comparison (with a tag), not
//                                  hidden as catch-all.
// `journal-software`            — OJS, Lodel, etc. — periodicals; excluded from repo-completeness headline.
// `generic-web`                 — WordPress, Drupal, MySQL — CMS / stacks that aren't repository software
//                                  per se but were detected as homepage signatures.
// `catchall`                    — "other" / "unknown" — the detection pipeline saw *something* but could
//                                  not match a platform family. Excluded from headline by default.
const REPOSITORY_PLATFORMS = new Set([
  "DSpace", "Dataverse", "EPrints", "Invenio", "InvenioRDM", "CKAN",
  "Samvera/Hyrax", "Fedora", "Figshare", "Zenodo", "Islandora", "MyCoRe",
  "Omeka", "OPUS", "bepress / Digital Commons", "GeoNetwork", "GeoNode",
  "TIND", "RADAR", "Nesstar",
]);
const JOURNAL_PLATFORMS = new Set(["OJS", "Lodel"]);
const GENERIC_WEB = new Set(["WordPress", "Drupal", "MySQL"]);
const CATCHALL = new Set(["other", "unknown"]);

export function platformClass(name) {
  if (name === "Custom / institutional") return "repository-software-custom";
  if (REPOSITORY_PLATFORMS.has(name))    return "repository-software-known";
  if (JOURNAL_PLATFORMS.has(name))       return "journal-software";
  if (GENERIC_WEB.has(name))             return "generic-web";
  if (CATCHALL.has(name))                return "catchall";
  return "other";
}

// Helper: which classes count as "real repository software" for the headline?
// The dashboard uses this to decide what to include by default.
export function isHeadlineRepoSoftware(cls) {
  return cls === "repository-software-known" || cls === "repository-software-custom";
}
