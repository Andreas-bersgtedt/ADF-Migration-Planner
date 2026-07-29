# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-29

First public release.

### Added

- React + Vite + TypeScript SPA with Microsoft Entra interactive sign-in (MSAL redirect flow).
- Subscription discovery and Azure Data Factory inventory via Azure Resource Graph.
- Factory inventory filtering, search, and selection gate before scanning.
- Local backend scan API (Node.js) that queries Data Factory pipeline and activity run history in day chunks, off the browser thread.
- Configurable scan profiles (1, 3, 5, 7 days) with live inventory, usage-scan, and day-chunk progress indicators.
- Usage metrics per factory: activity/pipeline/copy run counts, pipeline and external pipeline minutes, copy data moved, DIU-hours, mapping dataflow vCore minutes.
- Fabric CU-hour estimation (DIU, orchestration, mapping dataflow) and peak daily CU requirement per factory.
- Aggregate daily CU-hour rollup across factories with a minimum viable Fabric SKU recommendation card.
- Excel export of the usage summary table.
- Embedded SQLite as the authoritative backend store for runs, factories, daily metrics, pipeline runs, activity runs (with timestamps), scan errors, and checkpoints; browser IndexedDB retained as a UI cache.
- Resilient Azure scanning: retry with exponential backoff and jitter for `408`/`429`/`5xx`, honoring `Retry-After` headers, with configurable concurrency limits.
- Accurate run completion accounting that reflects partial/failed day chunks instead of reporting false success.
- Debug mode with a step-by-step debug trace panel for troubleshooting inventory and scan phases.
- `start.ps1` bootstrap script to clone/update, install, and run both the frontend and backend; prompts for a git repository URL and skips git entirely when left blank.
- npm workspace configuration so a single root `npm install` installs both frontend and backend dependencies.
- README and Quickstart documentation covering setup, required Azure access, configuration, metrics/calculations, and troubleshooting.

### Security

- Reviewed all documentation and tracked files for credentials, PII, and sensitive metadata prior to public release.
- Removed developer-specific editor configuration and a personal repository URL default that were not needed for public consumption.
