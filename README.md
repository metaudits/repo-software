# Repository Software — DataCite Consortium Audit

A software-platform audit and metadata-completeness analysis of every DataCite client affiliated with a consortium membership — paired with [Habermann (2026), "Community can help improve metadata"](https://metadatagamechangers.com/blog/2026/5/5/community-can-help-improve-metadata). Part of the [MetAudits](https://metaudits.rijdho.org) collective.

Live dashboard: <https://metaudits.rijdho.org/funded/repo-software/> (password-gated preview).

## What it does

For each DataCite consortium (74 consortia, 1,667 member organizations, 4,337 client repositories, ~125 million DOIs in total), the pipeline identifies the software platform running the repository (DSpace, Dataverse, OJS, Invenio, EPrints, …), checks whether the URL still responds, and samples a few DOI records per client to score metadata completeness over 12 DataCite fields grouped by Habermann's four use cases (Text, Identifiers, Connections, Contacts).

The dashboard then pairs **platform** with **completeness**:

- Per-consortium platform-mix bars (color-coded by software) along the same x-axis as Habermann's Figure 2.
- Bright-spot ranking of consortia with high platform monoculture — these are the highest-leverage targets for "fix the template once" interventions.
- A boxplot of completeness distribution per software platform. Headline finding: Dataverse repositories average **51.8% completeness** vs DSpace **34.7%** and EPrints **32.4%** — the spread between platforms is wider than Habermann's spread between consortia, suggesting the software is a stronger predictor of completeness than consortium affiliation.

## Key findings (2026-05-19 snapshot)

- **46.4% of 4,337 clients software-identified** across 11 detection tiers.
- **38.5% live URLs** (1,671 alive · 340 dead · 2,326 with no URL in DataCite at all).
- **20% of consortium clients have 0 DataCite DOIs** — registered identities that mint via Crossref or never went live.
- Top platforms among `clientType=repository`: DSpace 251 · Dataverse 137 · EPrints 68 · InvenioRDM 45 · CKAN 43 · OPUS 35 · bepress / Digital Commons 18.
- OJS dominates the `periodical` clientType separately (761 clients).
- Most homogeneous consortia: gdccco (84% Dataverse), escireco (70% OJS), tibco (64% OJS), ethzco (58% DSpace), blco (37% EPrints).

## Repository layout

```
pipeline/                          Node.js (.mjs) data pipeline (11 detection tiers + completeness scoring)
  00-fetch-consortiums.mjs         DataCite consortium providers + nested orgs
  01-fetch-clients.mjs             /clients per consortium with include=provider
  02-enrich-software.mjs           re3data lookup by DOI + HTML signature scan
  02b-url-patterns.mjs             URL path patterns (no HTTP)
  02c-text-and-host.mjs            Name/description keywords + hostname map (no HTTP)
  02d-oai-probe.mjs                OAI-PMH Identify probe at 6 standard paths
  02e-siblings.mjs                 Sibling propagation within providers (no HTTP)
  02f-manual-whitelist.mjs         Hand-curated labels for bespoke infrastructure
  02g-re3data-name-match.mjs       Fuzzy name match against re3data registry
  02h-doi-sample.mjs               Sample one DOI per unknown, follow landing page
  03-liveness.mjs                  URL probe + HTTP-header software detection
  03b-doi-counts.mjs               Real DOI counts via /dois?client-id=X&meta.total
  04-aggregate.mjs                 Roll up to dashboard JSONs
  05-completeness.mjs              Sample 3 DOIs per client, score on 12 fields, per-platform aggregate
  lib/http.mjs                     fetch with retry + concurrency map

data/                              Aggregated pipeline outputs (CC BY 4.0)
  manual-whitelist.json            Hand-curated mappings for custom infra (editable)
  consortiums.json                 74-consortium roster
  providers.json                   1,667 distinct providers
  orgs.json                        1,689 sub-org references
  completeness-samples.json        12-field completeness scores per client, per platform
  doi-counts.json                  Per-client DOI counts
  clients.per-consortium.json      Client count per consortium

web/                               React 19 + Vite 6 dashboard
  src/main.jsx                     6 tabs incl. "Habermann × Software" with platform-mix bars + completeness boxplot
  public/data/                     Aggregated JSONs consumed by the dashboard
```

## Running the pipeline

```bash
cd pipeline
npm run pipeline:consortiums      # ~5 sec
npm run pipeline:clients          # ~5-10 min (DataCite paginated by consortium)
npm run pipeline:enrich           # ~15-25 min (re3data + HTML probes)
npm run pipeline:url-patterns     # instant
npm run pipeline:text-host        # instant
npm run pipeline:oai              # ~10-20 min (OAI-PMH probe)
npm run pipeline:siblings         # instant
npm run pipeline:manual           # instant
npm run pipeline:re3-name         # ~2-5 min
npm run pipeline:doi-sample       # ~20-30 min (highest-yield single step — 545 hits)
npm run pipeline:liveness         # ~15-20 min (URL probe + HTTP-header detection)
npm run pipeline:doi-counts       # ~15-25 min (real DOI counts)
npm run pipeline:completeness     # ~10-15 min (12-field score, 3 DOIs per client)
npm run pipeline:aggregate        # ~5 sec
```

Intermediate caches (re3data XML responses, liveness probe results, per-client DOI counts, etc.) are kept locally so any step can be re-run without redoing previous work.

## Running the dashboard

```bash
cd web
npm install
npm run dev      # port 5181
npm run build    # production build
```

## License

- **Code** is released under the [MIT License](LICENSE).
- **Aggregated data** under `data/` and `web/public/data/` is released under [CC BY 4.0](LICENSE-DATA).

## Contributing

This is a public mirror of an internal MetAudits subproject; the canonical source lives in a private monorepo. Issues and pull requests are welcome — for substantial proposals please open an issue first to discuss scope.

The `data/manual-whitelist.json` file is the most accessible contribution surface: it maps custom-infrastructure repositories (NIFS, DiSSCo, GBIF, arXiv, DSMZ family, etc.) to explicit "Custom / institutional" labels with provenance notes. PRs adding more entries are especially welcome.
