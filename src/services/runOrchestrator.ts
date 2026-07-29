import { InteractionRequiredAuthError, type IPublicClientApplication } from '@azure/msal-browser';
import { db } from '../data/db';
import { inventoryFactoriesForSubscription, listSubscriptions } from '../api/azureManagement';
import { armScopes } from '../auth/msalConfig';
import type { FactoryUsageRecord, RunRecord, RunStepRecord, SubscriptionProgressRecord } from '../types/azure';
import { createId, utcNow } from '../utils/time';

const backendApiBaseUrl = (import.meta.env.VITE_SCAN_API_BASE_URL as string | undefined)?.trim() || 'http://localhost:7071';
const backendPollMs = Number(import.meta.env.VITE_SCAN_API_POLL_MS ?? 1500);
const MSAL_TOKEN_TIMEOUT_MS = Number(import.meta.env.VITE_MSAL_TOKEN_TIMEOUT_MS ?? 30000);
const DB_PREP_TIMEOUT_MS = Number(import.meta.env.VITE_DB_PREP_TIMEOUT_MS ?? 15000);
const INVENTORY_DISCOVERY_TIMEOUT_MS = Number(import.meta.env.VITE_INVENTORY_DISCOVERY_TIMEOUT_MS ?? 45000);
const INVENTORY_SUBSCRIPTION_TIMEOUT_MS = Number(import.meta.env.VITE_INVENTORY_SUBSCRIPTION_TIMEOUT_MS ?? 45000);
// Fail a scan only when the backend reports no forward progress for this long, rather than
// capping total scan duration (large multi-day scans can legitimately run for minutes).
const SCAN_NO_PROGRESS_TIMEOUT_MS = Number(import.meta.env.VITE_SCAN_NO_PROGRESS_TIMEOUT_MS ?? 120000);

interface BackendRunStatus {
  runId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  message?: string;
  lastError?: string;
}

interface BackendRunStatusResponse {
  run: BackendRunStatus;
}

interface BackendRunResultsResponse {
  run: BackendRunStatus;
  usage: FactoryUsageRecord[];
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function prepareDbForInventory(runId: string): Promise<void> {
  const cleanupWork = Promise.all([
    db.subscriptions.clear(),
    db.factories.clear(),
    db.subscriptionProgress.clear(),
    db.runSteps.clear(),
    // Keep run history bounded so old runs do not accumulate forever.
    db.runs.where('runId').notEqual(runId).delete(),
  ]);

  try {
    await withTimeout(cleanupWork, DB_PREP_TIMEOUT_MS, 'Local cache preparation');
  } catch {
    // Best effort only: stale local rows are less harmful than blocking the whole run startup.
  }
}

async function backendJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${backendApiBaseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Backend API request failed (${response.status}): ${body}`);
  }

  return (await response.json()) as T;
}

async function acquireArmToken(msalInstance: IPublicClientApplication): Promise<string> {
  const account = msalInstance.getActiveAccount() ?? msalInstance.getAllAccounts()[0] ?? null;
  if (!account) {
    throw new Error('No signed-in account found. Sign in and retry the usage scan.');
  }

  try {
    const token = await withTimeout(msalInstance.acquireTokenSilent({
      account,
      scopes: armScopes,
    }), MSAL_TOKEN_TIMEOUT_MS, 'Silent token acquisition');
    return token.accessToken;
  } catch (error) {
    if (error instanceof InteractionRequiredAuthError) {
      const token = await withTimeout(msalInstance.acquireTokenPopup({
        scopes: armScopes,
        prompt: 'select_account',
      }), Math.max(MSAL_TOKEN_TIMEOUT_MS, 120000), 'Interactive token acquisition');
      return token.accessToken;
    }

    throw error;
  }
}

function toRunStatus(status: BackendRunStatus['status']): RunRecord['status'] {
  if (status === 'completed') {
    return 'completed';
  }

  if (status === 'failed') {
    return 'failed';
  }

  return 'running';
}

async function logStep(step: RunStepRecord): Promise<void> {
  await db.runSteps.put(step);
}

async function setSubscriptionProgress(record: SubscriptionProgressRecord): Promise<void> {
  await db.subscriptionProgress.put(record);
}

export async function discoverSubscriptions(msalInstance: IPublicClientApplication): Promise<void> {
  const subscriptions = await listSubscriptions(msalInstance);
  await db.subscriptions.bulkPut(subscriptions);
}

export async function startInventoryRun(msalInstance: IPublicClientApplication, tenantId: string): Promise<RunRecord> {
  const run: RunRecord = {
    runId: createId('run'),
    tenantId,
    startedAtUtc: utcNow(),
    status: 'running',
    currentStep: 'discover-subscriptions',
  };

  await db.runs.put(run);
  let currentPhase = 'prepare-local-cache';

  await logStep({
    stepId: createId('step'),
    runId: run.runId,
    stepName: 'prepare-local-cache',
    status: 'running',
    startedAtUtc: utcNow(),
    message: 'Clearing local cache tables for a new inventory run.',
  });

  await prepareDbForInventory(run.runId);

  await logStep({
    stepId: createId('step'),
    runId: run.runId,
    stepName: 'prepare-local-cache',
    status: 'succeeded',
    startedAtUtc: utcNow(),
    completedAtUtc: utcNow(),
    message: 'Local cache preparation completed.',
  });

  const discoverStartedAt = utcNow();
  await logStep({
    stepId: createId('step'),
    runId: run.runId,
    stepName: 'discover-subscriptions',
    status: 'running',
    startedAtUtc: discoverStartedAt,
    message: 'Discovering subscriptions visible to the signed-in user.',
  });

  try {
    currentPhase = 'discover-subscriptions';
    await withTimeout(
      discoverSubscriptions(msalInstance),
      INVENTORY_DISCOVERY_TIMEOUT_MS,
      'Subscription discovery',
    );
  } catch (error) {
    await logStep({
      stepId: createId('step'),
      runId: run.runId,
      stepName: 'discover-subscriptions',
      status: 'failed',
      startedAtUtc: discoverStartedAt,
      completedAtUtc: utcNow(),
      message: error instanceof Error ? error.message : 'Subscription discovery failed.',
    });

    const failedRun: RunRecord = {
      ...run,
      completedAtUtc: utcNow(),
      status: 'failed',
      currentStep: 'discover-subscriptions-failed',
    };

    await db.runs.put(failedRun);
    throw new Error(error instanceof Error ? `Inventory failed during ${currentPhase}: ${error.message}` : 'Inventory failed during subscription discovery.');
  }

  const subscriptions = await db.subscriptions.orderBy('displayName').toArray();

  await logStep({
    stepId: createId('step'),
    runId: run.runId,
    stepName: 'discover-subscriptions',
    status: 'succeeded',
    startedAtUtc: discoverStartedAt,
    completedAtUtc: utcNow(),
    message: `Discovered ${subscriptions.length} subscriptions.`,
  });

  let hasFailure = false;

  for (const subscription of subscriptions) {
    const progressId = `${run.runId}:${subscription.subscriptionId}`;
    const subscriptionStepStartedAt = utcNow();

    await db.runs.update(run.runId, {
      currentSubscriptionId: subscription.subscriptionId,
      currentStep: 'inventory-factories',
    });

    await logStep({
      stepId: createId('step'),
      runId: run.runId,
      subscriptionId: subscription.subscriptionId,
      stepName: 'inventory-factories',
      status: 'running',
      startedAtUtc: subscriptionStepStartedAt,
      message: `Querying Data Factory resources for subscription ${subscription.subscriptionId}.`,
    });

    await setSubscriptionProgress({
      id: progressId,
      runId: run.runId,
      subscriptionId: subscription.subscriptionId,
      subscriptionName: subscription.displayName,
      status: 'inventory-running',
      lastStep: 'inventory-factories',
      updatedAtUtc: utcNow(),
    });

    try {
      currentPhase = `inventory-factories:${subscription.subscriptionId}`;
      const factories = await withTimeout(
        inventoryFactoriesForSubscription(msalInstance, subscription.subscriptionId),
        INVENTORY_SUBSCRIPTION_TIMEOUT_MS,
        `Factory inventory for ${subscription.subscriptionId}`,
      );
      if (factories.length > 0) {
        await db.factories.bulkPut(factories);
      }

      await logStep({
        stepId: createId('step'),
        runId: run.runId,
        subscriptionId: subscription.subscriptionId,
        stepName: 'inventory-factories',
        status: 'succeeded',
        startedAtUtc: subscriptionStepStartedAt,
        completedAtUtc: utcNow(),
        message: `Discovered ${factories.length} factories for ${subscription.subscriptionId}.`,
      });

      await setSubscriptionProgress({
        id: progressId,
        runId: run.runId,
        subscriptionId: subscription.subscriptionId,
        subscriptionName: subscription.displayName,
        status: 'inventory-complete',
        lastStep: 'inventory-factories',
        updatedAtUtc: utcNow(),
        errorMessage: undefined,
      });
    } catch (error) {
      hasFailure = true;

      await logStep({
        stepId: createId('step'),
        runId: run.runId,
        subscriptionId: subscription.subscriptionId,
        stepName: 'inventory-factories',
        status: 'failed',
        startedAtUtc: subscriptionStepStartedAt,
        completedAtUtc: utcNow(),
        message: error instanceof Error ? error.message : 'Factory inventory failed.',
      });

      await setSubscriptionProgress({
        id: progressId,
        runId: run.runId,
        subscriptionId: subscription.subscriptionId,
        subscriptionName: subscription.displayName,
        status: 'failed',
        lastStep: 'inventory-factories',
        updatedAtUtc: utcNow(),
        errorMessage: error instanceof Error ? error.message : 'Factory inventory failed.',
      });
    }
  }

  const completedRun: RunRecord = {
    ...run,
    completedAtUtc: utcNow(),
    status: hasFailure ? 'failed' : 'paused',
    currentStep: hasFailure ? 'inventory-failed' : 'awaiting-factory-selection',
  };

  await db.runs.put(completedRun);
  return completedRun;
}

export async function scanSelectedFactories(
  msalInstance: IPublicClientApplication,
  runId: string,
  selectedFactoryIds: string[],
  windowDays: number,
): Promise<RunRecord> {
  if (selectedFactoryIds.length === 0) {
    throw new Error('Select at least one factory before starting the usage scan.');
  }

  const run = await db.runs.get(runId);
  if (!run) {
    throw new Error(`Run ${runId} was not found. Start inventory again.`);
  }

  const selectedFactories = await db.factories.where('id').anyOf(selectedFactoryIds).toArray();
  if (selectedFactories.length === 0) {
    throw new Error('No matching factories were found for the current selection. Re-run inventory and select again.');
  }

  await db.runs.update(runId, {
    status: 'running',
    currentStep: 'collect-usage',
    completedAtUtc: undefined,
  });

  const factoriesBySubscription = new Map<string, typeof selectedFactories>();
  for (const factory of selectedFactories) {
    const bucket = factoriesBySubscription.get(factory.subscriptionId);
    if (bucket) {
      bucket.push(factory);
    } else {
      factoriesBySubscription.set(factory.subscriptionId, [factory]);
    }
  }

  for (const [subscriptionId, factories] of factoriesBySubscription.entries()) {
    const progressId = `${runId}:${subscriptionId}`;
    const existingProgress = await db.subscriptionProgress.get(progressId);

    await setSubscriptionProgress({
      id: progressId,
      runId,
      subscriptionId,
      subscriptionName: existingProgress?.subscriptionName,
      status: 'usage-running',
      lastStep: 'collect-usage',
      updatedAtUtc: utcNow(),
      errorMessage: undefined,
    });
  }

  try {
    const accessToken = await acquireArmToken(msalInstance);

    const createResponse = await backendJson<{ runId: string; status: string }>('/api/runs', {
      method: 'POST',
      body: JSON.stringify({
        windowDays,
        accessToken,
        factories: selectedFactories.map((factory) => ({
          id: factory.id,
          name: factory.name,
          subscriptionId: factory.subscriptionId,
          resourceGroup: factory.resourceGroup,
          location: factory.location,
        })),
      }),
    });

    const backendRunId = createResponse.runId;
    const perSubscriptionTargets = new Map<string, number>();
    for (const factory of selectedFactories) {
      perSubscriptionTargets.set(factory.subscriptionId, (perSubscriptionTargets.get(factory.subscriptionId) ?? 0) + 1);
    }

    let lastProgressSignature = '';
    let lastProgressAtMs = Date.now();

    while (true) {
      const [{ run: backendRun }, results] = await Promise.all([
        backendJson<BackendRunStatusResponse>(`/api/runs/${backendRunId}/status`),
        backendJson<BackendRunResultsResponse>(`/api/runs/${backendRunId}/results`),
      ]);

      const normalizedUsage = results.usage.map((row) => ({
        ...row,
        runId,
        id: `${runId}:${row.factoryId}`,
      }));

      if (normalizedUsage.length > 0) {
        await db.factoryUsage.bulkPut(normalizedUsage);
      }

      const usageBySubscription = new Map<string, FactoryUsageRecord[]>();
      for (const row of normalizedUsage) {
        const bucket = usageBySubscription.get(row.subscriptionId);
        if (bucket) {
          bucket.push(row);
        } else {
          usageBySubscription.set(row.subscriptionId, [row]);
        }
      }

      for (const [subscriptionId, targetCount] of perSubscriptionTargets.entries()) {
        const rows = usageBySubscription.get(subscriptionId) ?? [];
        const completedCount = rows.filter((item) => item.status === 'collected' || item.status === 'failed').length;
        const failedCount = rows.filter((item) => item.status === 'failed').length;
        const progressId = `${runId}:${subscriptionId}`;
        const existingProgress = await db.subscriptionProgress.get(progressId);

        let status: SubscriptionProgressRecord['status'] = 'usage-running';
        if (completedCount >= targetCount && targetCount > 0) {
          status = failedCount > 0 ? 'failed' : 'usage-complete';
        }

        await setSubscriptionProgress({
          id: progressId,
          runId,
          subscriptionId,
          subscriptionName: existingProgress?.subscriptionName,
          status,
          lastStep: 'collect-usage',
          updatedAtUtc: utcNow(),
          errorMessage: failedCount > 0 ? 'One or more factories failed usage collection.' : undefined,
        });
      }

      const status = toRunStatus(backendRun.status);
      const isTerminal = backendRun.status === 'completed' || backendRun.status === 'failed';

      await db.runs.update(runId, {
        status,
        currentStep: isTerminal ? (status === 'failed' ? 'collect-usage-failed' : 'completed') : 'collect-usage',
        completedAtUtc: isTerminal ? utcNow() : undefined,
      });

      if (isTerminal) {
        if (backendRun.status === 'failed') {
          throw new Error(backendRun.lastError ?? backendRun.message ?? 'Backend usage scan failed.');
        }

        const finalRun = await db.runs.get(runId);
        if (!finalRun) {
          throw new Error(`Run ${runId} was not found after backend completion.`);
        }

        return finalRun;
      }

      const completedRows = normalizedUsage.filter((row) => row.status === 'collected' || row.status === 'failed').length;
      const scannedChunks = normalizedUsage.reduce((sum, row) => sum + (Number(row.scannedDayChunks) || 0), 0);
      const progressSignature = `${backendRun.status}:${completedRows}:${scannedChunks}`;

      if (progressSignature !== lastProgressSignature) {
        lastProgressSignature = progressSignature;
        lastProgressAtMs = Date.now();
      } else if (
        SCAN_NO_PROGRESS_TIMEOUT_MS > 0 &&
        Date.now() - lastProgressAtMs > SCAN_NO_PROGRESS_TIMEOUT_MS
      ) {
        throw new Error(
          `Usage scan made no progress for ${Math.round(SCAN_NO_PROGRESS_TIMEOUT_MS / 1000)}s. The backend may be stalled; retry the scan.`,
        );
      }

      await sleep(Number.isFinite(backendPollMs) && backendPollMs > 0 ? backendPollMs : 1500);
    }
  } catch (error) {
    for (const subscriptionId of factoriesBySubscription.keys()) {
      const progressId = `${runId}:${subscriptionId}`;
      const existingProgress = await db.subscriptionProgress.get(progressId);
      await setSubscriptionProgress({
        id: progressId,
        runId,
        subscriptionId,
        subscriptionName: existingProgress?.subscriptionName,
        status: 'failed',
        lastStep: 'collect-usage',
        updatedAtUtc: utcNow(),
        errorMessage: error instanceof Error ? error.message : 'Usage collection failed.',
      });
    }

    await db.runs.update(runId, {
      status: 'failed',
      currentStep: 'collect-usage-failed',
      completedAtUtc: utcNow(),
    });

    throw new Error(
      error instanceof Error
        ? `${error.message} Ensure the backend API is running (npm run api:dev).`
        : 'Usage collection failed. Ensure the backend API is running (npm run api:dev).',
    );
  }
}
