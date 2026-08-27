# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.1] - 2026-08-27

### Added in 1.1.1

- Durable day-chunk checkpoints and same-run resume for failed, partial, missing, and interrupted scans.
- UI recovery of incomplete backend runs when browser-local scan state is unavailable or a newer run has completed.

### Fixed in 1.1.1

- Pipeline and activity query pagination now follows continuation tokens beyond 20 pages, with repeated-token detection and a configurable emergency ceiling.
- Subscription-scoped adaptive throttling prevents sibling factory scans from multiplying pressure against shared Azure limits.

## [1.1.0] - 2026-08-26

### Added in 1.1.0

- Per-scan JSON Lines trace logs with runtime settings, concurrency changes, ARM request attempts, retries, failures, and throughput.
- Factory inventory controls to enable or disable trace creation and download the current batch trace.
- Run-scoped trace download endpoint at `GET /api/runs/<run-id>/log` with token and secret redaction.
- In-app scan trace viewer with local file loading, live refresh, level/event/text filters, and expandable JSON entries.
- Default-off verbose trace mode for successful ARM request start/completion events, keeping standard scan logs compact.
- Documentation for ADF's fixed 1,000 monitoring-queries-per-minute limit, `TooManyPipelineRunQueryRequests`, and adaptive tuning guidance.
- Per-factory adaptive concurrency controllers and a run-scoped Factory concurrency UI setting capped at 10.
- Operating guide, API example, trace verification steps, and tested tuning profiles for per-factory adaptive scans.

## [1.0.0] - 2026-07-29

First public release.

### Added in 1.0.0

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
