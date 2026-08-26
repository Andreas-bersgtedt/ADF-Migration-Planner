# Quickstart: ADF Migration Planner

This quickstart gets you from zero to a working usage scan. It covers every prerequisite, the exact Azure access the signed-in user needs, environment configuration, and first run.

For deep reference material (all endpoints, metric formulas, troubleshooting), see the [README](../README.md).

---

## 1. Overview

The ADF Migration Planner is an internal dev-mode app with two parts:

1. A React single-page application (SPA) that signs in with Microsoft Entra and drives the workflow.
2. A local backend scan API that executes Azure Data Factory usage scans off the browser thread.

Data flow at a glance:

1. You sign in interactively (MSAL) and the SPA acquires an Azure Resource Manager (ARM) token.
2. The SPA discovers subscriptions and inventories Data Factory resources.
3. You select factories and start a scan.
4. The SPA forwards the ARM token to the backend, which queries pipeline/activity run history.
5. Results are aggregated into DIU-hours, Fabric CU-hour estimates, copy data moved, and peak daily CU.

---

## 2. Prerequisites

### 2.1 Local tooling

1. Windows, macOS, or Linux with a modern browser (Edge or Chrome recommended).
2. Node.js 20 or later, plus npm.
3. Git (required for the bootstrap script or clone workflow).
4. PowerShell 5.1+ or PowerShell 7+ if you use [start.ps1](../start.ps1).
5. Azure CLI (optional) — only needed if you run the backend API standalone without a forwarded SPA token.

### 2.2 Microsoft Entra app registration

Create or reuse an Entra app registration configured as a SPA:

1. Platform type: Single-page application.
2. Redirect URI: `http://localhost:5173`.
3. No client secret (public client SPA using authorization code flow with PKCE).

Delegated API permissions to grant on the app registration:

1. Azure Service Management → `user_impersonation` (allows calling ARM as the signed-in user).
2. Microsoft Graph → `User.Read` (basic sign-in/profile).

After adding permissions, grant admin consent if your tenant requires it.

### 2.3 Required Azure access for the signed-in user

The app can only return data the signed-in user is authorized to read. Grant the user the access below on every target subscription (or narrower scope such as resource group / factory if you want to limit visibility).

#### Recommended: `Reader` role

Assigning the built-in `Reader` role at subscription scope is sufficient for all current functionality:

1. Enumerate subscriptions.
2. Run Azure Resource Graph queries to discover Data Factory resources.
3. Read Data Factory pipeline run and activity run history.

#### Granular permissions (if your org restricts broad Reader assignment)

If you must scope down to a custom role, include these actions:

| Purpose | Action |
| --- | --- |
| List subscriptions | `Microsoft.Resources/subscriptions/read` |
| Resource Graph discovery | `Microsoft.ResourceGraph/resources/read` |
| Read Data Factory resources | `Microsoft.DataFactory/factories/read` |
| Query pipeline runs | `Microsoft.DataFactory/factories/queryPipelineRuns/action` |
| Read pipeline runs | `Microsoft.DataFactory/factories/pipelineruns/read` |
| Query activity runs | `Microsoft.DataFactory/factories/pipelineruns/queryActivityruns/action` |
| Read activity runs | `Microsoft.DataFactory/factories/activityruns/read` |

Notes:

1. Subscription enumeration requires at least one RBAC role assignment at subscription scope; without it the subscription will not appear.
2. Access must be granted on each subscription you want scanned. Missing access on a subscription surfaces as a failed subscription entry rather than blocking the whole run.
3. No write permissions are required. The app is read-only against Azure.

---

## 3. Configuration

Copy `.env.local.example` to `.env.local` in the repository root and set the core values:

```env
VITE_AUTH_MODE=msal
VITE_AZURE_CLIENT_ID=<your-spa-app-client-id>
VITE_AZURE_TENANT_ID=<your-tenant-id-or-organizations>
VITE_AZURE_REDIRECT_URI=http://localhost:5173
```

Optional settings (safe defaults are built in):

```env
VITE_SCAN_API_BASE_URL=http://localhost:7071
VITE_SCAN_API_POLL_MS=1500
VITE_MSAL_TOKEN_TIMEOUT_MS=30000
VITE_ARM_FETCH_TIMEOUT_MS=45000
VITE_DB_PREP_TIMEOUT_MS=15000
VITE_INVENTORY_DISCOVERY_TIMEOUT_MS=45000
VITE_INVENTORY_SUBSCRIPTION_TIMEOUT_MS=45000
VITE_SCAN_NO_PROGRESS_TIMEOUT_MS=120000
```

Optional backend settings (environment variables for the API process):

```env
PORT=7071
SCAN_API_ALLOWED_ORIGIN=http://localhost:5173
SCAN_ARM_FETCH_TIMEOUT_MS=60000
SCAN_ARM_FETCH_MAX_RETRIES=5
SCAN_ACTIVITY_QUERY_CONCURRENCY=4
SCAN_DAY_WINDOW_CONCURRENCY=3
SCAN_FACTORY_CONCURRENCY=2
SCAN_ADAPTIVE_CONCURRENCY_MIN=1
SCAN_ADAPTIVE_CONCURRENCY_START=3
SCAN_ADAPTIVE_CONCURRENCY_MAX=8
SCAN_ADAPTIVE_CONCURRENCY_STABLE_WINDOW=3
SCAN_MAX_RETAINED_RUNS=50
SCAN_DATABASE_PATH=server/data/adf-migration-planner.sqlite
SCAN_LOG_DIRECTORY=server/logs
```

`SCAN_LOG_DIRECTORY` sets the trace-file directory. The default is `server/logs`.

### Adaptive scan settings

Each selected factory has an independent adaptive controller and activity-query gate. The scan form's **Min / Start / Max** and **Stable window** values configure every factory controller for that run. A throttle from one factory does not reduce another factory's limit.

**Factory concurrency** controls how many factories are scanned simultaneously. It defaults to `2`, accepts `1–10`, and overrides `SCAN_FACTORY_CONCURRENCY` for that run. Raising it increases aggregate ARM traffic but does not change any factory's 1,000 monitoring-query-per-minute allowance.

Use this process for the first scan after upgrading:

1. Select the factories and leave **Factory concurrency** at `2`.
2. Enable **Adaptive scan** and enter `1 / 2 / 4` for **Min / Start / Max**.
3. Set **Stable window** to `15`.
4. Keep **Trace log** enabled. Enable **Verbose trace** when request-rate measurements are required.
5. Start the scan and review the trace after completion.
6. Filter the trace viewer to `arm-request-failed` to count `429` responses.
7. Filter to `adaptive-concurrency-changed` and search each throttled factory name. Only that factory should show a throttle reduction.
8. Increase **Factory concurrency** one step at a time when scans complete without subscription-level ARM pressure. Do not increase adaptive **Max** to compensate for a per-factory `429`.

The per-factory adaptive controls work as follows:

1. **Start** is the initial number of concurrent activity-run traversals.
2. **Stable window** is the number of successful ARM responses required to increase the limit by one.
3. **Max** is the ceiling reached through successful responses.
4. **Min** is the floor used after throttling or low rate-limit headroom.

Azure `408`, `429`, and `5xx` responses reduce the affected factory's limit and trigger retry backoff. Requests already running are allowed to finish; that factory's queued activity queries wait for capacity under the new limit. Pipeline and activity responses both contribute to the factory's adaptation, although its gate applies only to activity-run traversals.

The tested baseline is `1 / 2 / 4` with a stable window of `15`. If one factory still throttles frequently, use `1 / 1 / 2` with a stable window of `30`. Increase the maximum only after that factory's trace shows stable throughput without repeated `429` responses.

When adaptive scanning is disabled, `SCAN_ACTIVITY_QUERY_CONCURRENCY` becomes the fixed per-factory activity-query limit. Environment values are read when the backend starts; restart the API after changing them. See [Adaptive scanning](../README.md#adaptive-scanning) for precedence, exact scale-down rules, and tuning guidance.

Azure Data Factory allows 1,000 monitoring queries per minute. A `429` with code `TooManyPipelineRunQueryRequests` means the factory named in the response reached that fixed service limit. The scanner reduces that factory's concurrency and retries automatically. See [ADF monitoring-query limit](../README.md#adf-monitoring-query-limit) for scope, test results, and troubleshooting details.

Direct API callers can set the same behavior with `factoryConcurrency` and `adaptive` in `POST /api/runs`. See [Run API](../README.md#run-api) for the request body. New trace logs record `adaptiveControllerScope: "factory"`; every `adaptive-concurrency-changed` event includes `factoryName` and `factoryId`.

The backend persists scan data in embedded SQLite at `server/data/adf-migration-planner.sqlite` by default. This includes activity start/end timestamps, pipeline runs, daily metrics, errors, and checkpoints. IndexedDB is used as a browser-side UI cache; SQLite is the authoritative scan store.

Configuration checks:

1. Sign-in fails without `VITE_AZURE_CLIENT_ID`.
2. `AADSTS700038` usually means the client ID is a placeholder or invalid.
3. `AADSTS50011` means the redirect URI does not exactly match the app registration.

### 3.1 Alternate mode for `AADSTS50105`

When tenant policy requires assignment to the planner's enterprise application and the user cannot obtain it, sign in through the tenant-approved Azure CLI client:

```powershell
az login --tenant <customer-tenant-id>
az account set --subscription <subscription-id>
```

Then use this `.env.local` configuration:

```env
VITE_AUTH_MODE=azure-cli
VITE_SCAN_API_BASE_URL=http://localhost:7071
```

Start both processes as usual. The app header shows the active CLI user, and **Refresh CLI session** checks it again. Azure CLI must still be allowed by tenant policy, and the signed-in user must have the required Azure RBAC access.

### 3.2 Client-secret mode

Client secrets cannot be stored in a browser SPA. The planner implements this option in the local Node backend with MSAL Node's confidential-client flow.

Set `.env.local` to:

```env
VITE_AUTH_MODE=client-secret
VITE_SCAN_API_BASE_URL=http://localhost:7071
```

In the same PowerShell session used to launch the app, set:

```powershell
$env:SCAN_AUTH_MODE = 'client-secret'
$env:AZURE_TENANT_ID = '<tenant-id>'
$env:AZURE_CLIENT_ID = '<app-client-id>'
$env:AZURE_CLIENT_SECRET = '<client-secret>'
./start.ps1 -UseCurrentRepo
```

Never use a `VITE_*` variable for the secret. Assign the service principal `Reader` or the documented granular role on each target Azure scope. User assignment is not involved because ARM authorizes the service principal rather than an interactive user.

---

## 4. Install and run

### Option A: One command (recommended)

From the repository root:

```powershell
./start.ps1 -UseCurrentRepo
```

This clears local `node_modules` and npm cache, installs dependencies, starts the backend API in a separate window, and starts the frontend in the current window. The backend stops automatically when the frontend exits.

### Option B: Manual (two terminals)

Terminal 1 — backend API:

```powershell
npm install
npm run api:dev
```

Terminal 2 — frontend:

```powershell
npm run dev
```

Then open the shown local URL (default `http://localhost:5173`).

---

## 5. First run

1. Click **Sign in** and complete Entra interactive authentication.
2. Click **Start inventory run** to discover subscriptions and inventory factories.
3. In **Factory inventory**, filter/search and select the factories to scan.
4. Pick a **Scan profile** (1, 3, 5, or 7 days).
5. Leave **Trace log** enabled to create a separate diagnostic file for this scan, or disable it when no trace is needed.
6. Leave **Verbose trace** disabled for a compact diagnostic log. Enable it only when every successful ARM request start and completion is needed.
7. Click **Scan selected factories**.
8. Use **Download trace log** beside the scan button to retrieve the file during or after the scan.
9. In **Scan trace viewer**, load the current trace or open a downloaded trace file. Filter by level, event, or text, then select a row to inspect its JSON.
10. Review the **Usage summary** table. Results are retained across scans until you click **Clear results**.
11. Optional: enable **Debug mode** in Execution status to show the **Debug trace** panel for step-by-step diagnostics.
12. Optional: click **Export to Excel** to download the current results.

---

## 6. Verify access quickly

If a scan returns no data or a subscription fails, confirm access before debugging further:

1. Confirm the user has `Reader` (or the granular actions above) on the target subscription.
2. Confirm the app registration has `user_impersonation` on Azure Service Management with admin consent.
3. Enable **Debug mode** and read the newest **Debug trace** entries to see which phase failed (`discover-subscriptions` or `inventory-factories:<subscriptionId>`).
4. For a usage-scan failure, download the scan trace and search for `arm-request-failed`, `arm-request-error`, or `scan-failed`.

---

## 7. Next steps

1. Review metric definitions and formulas in the [README](../README.md#metrics-and-calculations).
2. Review backend endpoints in the [README](../README.md#backend-scan-api).
3. Review troubleshooting guidance in the [README](../README.md#troubleshooting).
