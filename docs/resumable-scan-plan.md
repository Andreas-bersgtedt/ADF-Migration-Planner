# Resumable ADF Usage Scan Plan

## Goal

Resume an interrupted or failed usage scan without querying factories and UTC day windows that already completed. A resume keeps the original run ID and time boundaries, retries `failed` and `partial` chunks, recovers abandoned `running` chunks, and rebuilds factory totals from persisted daily metrics.

The durable work unit is:

```text
(run_id, factory_id, window_start_utc, window_end_utc)
```

A calendar label such as `2026-08-26` remains useful for display, but it is not the resume boundary by itself.

## Current Behavior

The backend already has useful foundations:

- `checkpoints` records one status per run, factory, and metric date.
- Pipeline runs, activity runs, and daily metrics use idempotent upserts.
- ADF pipeline-run and activity-run queries follow continuation tokens.
- ARM requests retry 408, 429, and 5xx responses and honor common retry headers.
- Adaptive request concurrency drops after throttling.

The current implementation cannot resume correctly because:

1. `POST /api/runs` always creates a new backend run.
2. Checkpoints can be written but cannot be listed or claimed for execution.
3. Day windows are rebuilt from the current time, so a later retry does not reproduce the original boundaries.
4. Factory totals are accumulated in memory. Skipping completed days would omit their metrics from the resumed total.
5. A `partial` day is treated as scanned but is not counted in `failedDayChunks`.
6. Each factory has an independent adaptive controller. Scanning many factories in one subscription can multiply concurrency against the same subscription and Data Factory resource-provider limits.
7. Query pagination stops after 20 pages without failing when another continuation token exists. A busy factory can therefore produce a successful but incomplete day.
8. Browser and backend run IDs are separate, and the browser does not retain the backend ID as resumable state.

## Run and Chunk State

### Runs

Persist the scan definition when the backend run is created:

- `run_id`
- `scan_start_utc`
- `scan_end_utc`
- `window_days`
- selected factory snapshot
- concurrency and adaptive settings
- `status`: `queued`, `running`, `paused`, `failed`, `completed`, or `cancelled`
- `resume_count`
- `last_resumed_at_utc`

`scan_start_utc` and `scan_end_utc` never change during resume. A fresh incremental scan creates a new run with a new range.

### Chunks

Replace the minimal checkpoint record with a durable chunk record, or extend `checkpoints` with:

- `window_start_utc` and `window_end_utc`
- `status`: `pending`, `running`, `completed`, `partial`, or `failed`
- `attempt_count`
- `last_started_at_utc` and `last_completed_at_utc`
- `last_error_scope`, `last_error_message`, and `last_http_status`
- `next_attempt_at_utc`
- `lease_owner` and `lease_expires_at_utc`
- API call, retry, and throttle counts

Create all chunks before starting Azure requests. This makes total work and missing work queryable even if the server stops immediately afterward.

Status rules:

- `completed`: every pipeline and activity page for the chunk was retrieved and committed.
- `partial`: the pipeline list completed, but at least one activity-run query failed.
- `failed`: the pipeline query or another chunk-level operation failed.
- Expired `running`: treated as abandoned and eligible for resume.
- Only `completed` is skipped by the default resume mode.

## Consistent Chunk Commit

Add `metric_date` or a chunk ID to `pipeline_runs` and `activity_runs`. Persist one attempt with a SQLite transaction:

1. Fetch every pipeline page. If a continuation token remains after a configurable safety limit, fail the chunk rather than truncating it.
2. Fetch every activity page for every pipeline run.
3. Calculate the daily metric from the fetched attempt.
4. In one transaction, replace prior detail rows for that chunk, upsert its daily metric, and set the checkpoint status.
5. Commit `partial` results only when the UI needs provisional values. Mark them clearly and replace them in full on resume.

Do not add a daily metric to an existing factory summary in memory. After each chunk commit, derive the factory summary from all persisted `daily_metrics` rows for that run and factory. This includes previously completed days and prevents double counting after repeated resumes.

Expose separate counts for `completed`, `partial`, `failed`, `pending`, and `running`. Progress should be:

$$
\text{progress} = \frac{\text{completed chunks}}{\text{total chunks}}
$$

Partial and failed chunks are processed attempts, but they are not complete work.

## Resume API

Add these backend operations:

```text
POST /api/runs/{runId}/resume
GET  /api/runs/{runId}/chunks
POST /api/runs/{runId}/pause
```

Resume request:

```json
{
  "mode": "failed-and-missing",
  "factoryIds": [],
  "resetAttempts": false
}
```

Supported modes:

- `failed-and-missing`: run `failed`, `partial`, `pending`, and expired `running` chunks. This is the default.
- `failed-only`: run `failed` and `partial` chunks.
- `all`: explicitly rescan every chunk in the original fixed window.

Return `409 Conflict` if the run already has an active, unexpired execution lease. Make resume idempotent: repeated requests may claim eligible chunks once, but must not create another copy of the run.

On backend startup, change stale `running` runs to `paused` and leave their expired chunks eligible for resume. Do not automatically make Azure calls until the operator selects resume.

## Scheduler and Throttling

The concurrency controller should be shared by subscription, not created independently for every factory. Use three gates:

1. A conservative global factory gate.
2. A per-subscription request gate shared by all factories in that subscription.
3. A per-factory activity-query gate to prevent one busy factory from consuming every worker.

On 429:

- Honor `x-ms-retry-after-ms`, `retry-after-ms`, or `Retry-After` when present.
- Apply the cooldown to the subscription gate so sibling factories stop sending requests during the same throttle window.
- Use exponential backoff with jitter when the service does not provide a delay.
- Persist the final HTTP status, delay, request scope, and retry count on the chunk attempt.

Track both ARM headers and provider-specific behavior. A healthy ARM subscription-read header does not rule out throttling by `Microsoft.DataFactory`.

Recommended initial settings for the customer workload:

- Factory concurrency: 1 per subscription.
- Activity query concurrency: 1 or 2 per factory.
- Day-window concurrency: 1 per factory until throttle data shows safe headroom.
- Increase concurrency only after several successful requests; reduce it immediately on 429.

These are starting controls, not fixed Azure limits. Record observed 429 rate, retry delay, calls per subscription, and chunk duration before raising them.

## Incremental Scans

Resume and incremental scan are different operations:

- Resume completes the exact frozen range of an existing run.
- Incremental scan creates a new run from the last globally complete UTC boundary to a chosen end time.

Do not advance a factory watermark past a `partial` or `failed` chunk. Store a per-factory `complete_through_utc` watermark derived from contiguous completed chunks. If August 24 and 26 completed but August 25 failed, the watermark remains at the start of August 25. The next incremental run includes the gap plus later unscanned windows.

For the first delivery, implement resume only. Add watermark-based incremental scans after the same-run resume path is proven under load.

## UI Changes

Persist the backend run ID on the browser `RunRecord`. For a failed or paused run, show:

- `Resume failed/missing chunks`
- `Retry failed chunks`
- completed, partial, failed, pending, and running chunk counts
- factories affected and the oldest missing UTC day
- last throttle response and next eligible retry time

Keep `Scan selected factories` as the command for a new run. A resume must not ask the user to reselect factories or choose another date range.

The results grid should label totals as partial while any chunk for that factory is not `completed`. Excel export should include run completeness and chunk counts so provisional totals are not mistaken for final sizing data.

## Delivery Order

### Phase 1: Same-run resume

1. Add fixed run boundaries and expanded chunk state.
2. Materialize all chunks before scanning.
3. Add checkpoint reads, chunk claiming, leases, and startup recovery.
4. Recompute factory summaries from `daily_metrics`.
5. Add `POST /api/runs/{runId}/resume` and persist the backend run ID in IndexedDB.
6. Add the resume button and chunk status display.

### Phase 2: Data integrity and load control

1. Commit chunk detail, metric, and checkpoint state in one transaction.
2. Remove silent 20-page truncation; fail explicitly at a configurable safety limit.
3. Move adaptive concurrency to subscription-scoped gates.
4. Add structured throttle and attempt telemetry.

### Phase 3: Incremental operation

1. Add contiguous per-factory watermarks.
2. Generate gap chunks before new forward-looking chunks.
3. Add scheduled or operator-triggered incremental runs.
4. Add retention rules that preserve source runs used by active watermarks.

## Tests and Acceptance Criteria

Add automated tests around the scanner and state store before enabling resume for large batches.

Required cases:

1. Stop the process after some chunks complete; resume queries only pending and expired-running chunks.
2. Return 429 with each supported retry header; sibling factories in the subscription observe the shared cooldown.
3. Exhaust retries for one activity query; the chunk becomes `partial`, the factory remains incomplete, and resume replaces the partial metric.
4. Resume the same run twice; no chunk is claimed twice and factory totals do not increase.
5. Leave a continuation token on page 20; the chunk fails instead of being marked complete.
6. Complete days on both sides of a failed day; the incremental watermark does not cross the gap.
7. Restart the backend with `running` rows; stale leases become resumable.
8. Resume a seven-day factory with six completed days; the final factory total includes all seven persisted daily metrics.

The feature is ready when a killed backend can restart and finish the same run, all non-completed chunks are visible before resume, completed chunks cause no ADF calls, and repeated resumes produce identical final totals.

## Azure References

- [Azure Resource Manager request limits and throttling](https://learn.microsoft.com/azure/azure-resource-manager/management/request-limits-and-throttling)
- [Data Factory pipeline runs: query by factory](https://learn.microsoft.com/rest/api/datafactory/pipeline-runs/query-by-factory)
- [Data Factory activity runs: query by pipeline run](https://learn.microsoft.com/rest/api/datafactory/activity-runs/query-by-pipeline-run)
- [Data Factory troubleshooting: continuation token handling](https://learn.microsoft.com/azure/data-factory/data-factory-troubleshoot-guide#general)
