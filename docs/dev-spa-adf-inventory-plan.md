# Dev-Mode SPA Plan: Azure Data Factory Inventory and 7-Day DIU-Hours

> Note: This document is the original planning baseline. For current installation, setup, and day-to-day operation instructions, see the [Quickstart](QUICKSTART.md) and [README](../README.md).

## Purpose

Build an internal, dev-mode single-page application that:

1. Uses Microsoft Entra interactive authentication through MSAL.
2. Connects to a target tenant.
3. Lists all subscriptions visible to the signed-in user.
4. Runs Azure Data Factory inventory subscription by subscription.
5. Pulls or derives 7-day DIU-hours consumed for each factory.
6. Records every execution step so the process can be resumed after interruption.

## Scope and Assumptions

This solution is intentionally dev-only and internal.

1. The app is a browser SPA with no mandatory backend in the first version.
2. Authentication is interactive user sign-in only.
3. Tenant-wide visibility means all subscriptions the signed-in user can access.
4. The tool prioritizes traceability and restartability over raw speed.
5. The tool is allowed to store local execution state in the browser.

## Recommended Stack

1. React + Vite.
2. `@azure/msal-browser` and `@azure/msal-react`.
3. TypeScript.
4. Local browser persistence with IndexedDB.
5. Optional export/import of run state as JSON.

## High-Level Architecture

### Front End Modules

1. Auth module
   - Signs in the user with MSAL.
   - Acquires tokens for Azure management APIs.
   - Tracks current tenant and account context.

2. Tenant discovery module
   - Lists subscriptions available to the signed-in user.
   - Stores subscription discovery results with timestamps.

3. Inventory orchestrator
   - Runs the inventory pipeline one subscription at a time.
   - Schedules and records each step.
   - Supports pause, resume, retry, and restart from checkpoint.

4. Azure data access module
   - Calls Resource Graph and ARM/Data Factory REST endpoints.
   - Handles paging, throttling, and retry.

5. State store
   - Persists runs, checkpoints, step logs, subscription status, factory inventory, and usage aggregates.

6. UI module
   - Shows subscriptions, execution status, errors, results, and restart controls.

## Authentication Plan

### MSAL Configuration

Use authorization code flow with PKCE through MSAL Browser.

1. App registration type: SPA.
2. Sign-in: interactive redirect or popup.
3. Token target: Azure Resource Manager audience.
4. Primary scope request: `https://management.azure.com/.default`.

### Dev-Mode Notes

1. No client secret is used.
2. Tokens remain in the browser only.
3. Use session storage first unless longer-lived restarts are required.
4. If restart across browser restarts matters, persist non-token execution state in IndexedDB.

## Core User Flow

1. User signs in.
2. App resolves the active tenant.
3. App lists all accessible subscriptions.
4. User starts an inventory run.
5. App creates a run record.
6. App processes each subscription sequentially or with low parallelism.
7. For each subscription, the app records every step and checkpoint.
8. If interrupted, the app resumes from the last incomplete step.
9. The UI presents both final results and execution history.

## Inventory Workflow

### Phase 1: Subscription Discovery

Goal: enumerate subscriptions the signed-in user can access.

Planned output per subscription:

1. Subscription ID.
2. Subscription name.
3. Tenant ID.
4. State.
5. Discovery timestamp.

Execution record example:

1. `discover-subscriptions.started`
2. `discover-subscriptions.succeeded`

### Phase 2: Per-Subscription Factory Inventory

Goal: for each subscription, inventory all `Microsoft.DataFactory/factories` resources.

Recommended query path:

1. Use Azure Resource Graph scoped to a subscription.
2. Fallback to ARM resource listing if needed.

Fields to store per factory:

1. Resource ID.
2. Factory name.
3. Subscription ID.
4. Resource group.
5. Region.
6. Tags.
7. Provisioning state if available.
8. Discovery timestamp.

Execution record example for each subscription:

1. `subscription.<id>.inventory.started`
2. `subscription.<id>.inventory.querying-resource-graph`
3. `subscription.<id>.inventory.persisted`
4. `subscription.<id>.inventory.succeeded`

### Phase 3: 7-Day DIU-Hours Collection

Goal: compute DIU-hours per factory for the last 7 days.

Important note:

Do not assume Data Factory platform metrics directly expose exact DIU-hours per factory. For accuracy, derive DIU-hours from copy activity execution details when available.

Recommended formula:

$$
\text{DIU Hours} = \sum \left(\text{usedDataIntegrationUnits} \times \frac{\text{copyDurationSeconds}}{3600}\right)
$$

Per factory process:

1. Query pipeline runs for the last 7 days.
2. Query activity runs for each pipeline run.
3. Filter to copy activities.
4. Read activity output details.
5. Extract `usedDataIntegrationUnits` and `copyDuration`.
6. Aggregate DIU-hours by factory.
7. Persist detailed and summarized results.

Store these usage fields:

1. Factory resource ID.
2. Window start UTC.
3. Window end UTC.
4. Copy run count.
5. Pipeline run count.
6. Total DIU-hours.
7. Last successful usage refresh.
8. Collection warnings.

Execution record example:

1. `subscription.<id>.usage.started`
2. `subscription.<id>.usage.pipeline-runs-loaded`
3. `subscription.<id>.usage.activity-runs-loaded`
4. `subscription.<id>.usage.aggregated`
5. `subscription.<id>.usage.succeeded`

## Restartability and Checkpoint Design

This is a hard requirement.

Every meaningful action must be persisted before the next action starts.

### Persistence Model

Use IndexedDB tables or equivalent collections for:

1. `runs`
2. `runSteps`
3. `subscriptions`
4. `subscriptionProgress`
5. `factories`
6. `factoryUsage`
7. `errors`

### Run Record

Suggested fields:

1. `runId`
2. `tenantId`
3. `startedAtUtc`
4. `completedAtUtc`
5. `status` (`not-started`, `running`, `paused`, `failed`, `completed`, `cancelled`)
6. `currentSubscriptionId`
7. `currentStep`
8. `resumeToken` or checkpoint pointer
9. `notes`

### Step Log Record

Suggested fields:

1. `stepId`
2. `runId`
3. `subscriptionId`
4. `factoryId`
5. `stepName`
6. `status`
7. `attempt`
8. `startedAtUtc`
9. `completedAtUtc`
10. `message`
11. `payloadSummary`

### Resume Rules

On app start:

1. Load the latest incomplete run.
2. Inspect the last completed step.
3. Resume from the next incomplete step.
4. Never re-run a completed subscription step unless the user explicitly requests retry.
5. Mark partial work clearly.

### Retry Rules

1. Retry transient ARM failures with exponential backoff.
2. Retry throttling responses with server-suggested delays when available.
3. Limit retries per step.
4. Persist the failure after final retry.

## Execution Strategy

To satisfy the requirement that inventory runs subscription by subscription, use this default order:

1. Discover all subscriptions.
2. Sort subscriptions by name.
3. For each subscription:
   - inventory factories
   - persist inventory results
   - collect 7-day usage
   - persist usage results
   - mark subscription complete

Recommended concurrency:

1. Subscription processing: 1 at a time by default.
2. Within a subscription, allow low parallelism for factory usage collection only if throttling is controlled.

## UI Plan

### Screens

1. Sign-in screen
   - Sign in
   - Sign out
   - Show tenant and account

2. Subscription screen
   - List accessible subscriptions
   - Show per-subscription status
   - Start run
   - Resume run

3. Run monitor screen
   - Current run status
   - Current subscription
   - Current step
   - Step history
   - Errors
   - Pause and retry actions

4. Results screen
   - Factory inventory grid
   - 7-day DIU-hours summary
   - Drill-down by subscription and factory

5. Recovery screen
   - Show incomplete runs
   - Resume from checkpoint
   - Restart failed subscriptions only

### UX Requirements

1. Every long-running action must expose progress.
2. Every subscription row must show last checkpoint and last error.
3. The user must be able to resume without re-running completed subscriptions.
4. The user must be able to export the current run log.

## API and Query Plan

### Subscription List

Use Azure subscription listing for the signed-in user.

### Factory Inventory Query

Preferred query shape:

```kusto
Resources
| where type =~ 'microsoft.datafactory/factories'
| project id, name, subscriptionId, resourceGroup, location, tags
```

Scope this query one subscription at a time for checkpoint simplicity.

### Usage Query Approach

Use Data Factory management/run APIs to:

1. Pull pipeline runs for 7 days.
2. Pull activity runs per pipeline run.
3. Parse copy activity outputs.
4. Compute DIU-hours client-side.

## Data Model Summary

### Subscription Progress

Suggested status values:

1. `not-started`
2. `inventory-running`
3. `inventory-complete`
4. `usage-running`
5. `usage-complete`
6. `failed`
7. `skipped`

### Factory Usage Summary

Suggested fields:

1. `factoryId`
2. `subscriptionId`
3. `factoryName`
4. `windowDays`
5. `copyRunCount`
6. `pipelineRunCount`
7. `totalDiuHours`
8. `warningCount`
9. `lastComputedAtUtc`

## Error Handling

Persist and expose the following classes of errors:

1. Authentication errors.
2. Authorization errors.
3. Subscription enumeration failures.
4. Resource Graph query failures.
5. Data Factory run-history query failures.
6. Missing copy activity output details.
7. Throttling and timeout failures.

Errors should be attached to the run, the subscription, and the step that failed.

## Delivery Phases

### Phase 1

1. SPA scaffold.
2. MSAL interactive login.
3. Subscription listing.
4. Local persistence model.

### Phase 2

1. Subscription-by-subscription factory inventory.
2. Step logging and checkpoints.
3. Resume from interruption.

### Phase 3

1. 7-day pipeline run and activity run collection.
2. DIU-hours derivation.
3. Aggregated results UI.

### Phase 4

1. Retry controls.
2. Export/import run logs.
3. Targeted rerun of failed subscriptions.

## Success Criteria

The first usable version is successful when it can:

1. Sign in interactively.
2. Connect to the intended tenant.
3. List all accessible subscriptions.
4. Inventory Data Factories one subscription at a time.
5. Derive 7-day DIU-hours for each factory.
6. Persist every step.
7. Resume after browser refresh or interruption without losing completed work.

## Recommended Next Step

Create the SPA scaffold and start with these implementation slices in order:

1. MSAL sign-in and tenant context.
2. Subscription discovery and persistence.
3. Run orchestration and checkpoint logging.
4. Factory inventory per subscription.
5. DIU-hours usage calculation.
