import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConfidentialClientApplication } from '@azure/msal-node';
import {
  recordScanError,
  upsertActivityRuns,
  upsertCheckpoint,
  upsertDailyMetric,
  upsertPipelineRuns,
} from './state.js';

const execFileAsync = promisify(execFile);

const ARM_ENDPOINT = 'https://management.azure.com';
const ACTIVITY_RUN_QUERY_CONCURRENCY = Number(process.env.SCAN_ACTIVITY_QUERY_CONCURRENCY ?? 2);
const DAY_WINDOW_CONCURRENCY = Number(process.env.SCAN_DAY_WINDOW_CONCURRENCY ?? 3);
const FACTORY_SCAN_CONCURRENCY = Number(process.env.SCAN_FACTORY_CONCURRENCY ?? 2);
const DEFAULT_ADAPTIVE_CONCURRENCY = {
  enabled: true,
  min: Number(process.env.SCAN_ADAPTIVE_CONCURRENCY_MIN ?? 1),
  start: Number(process.env.SCAN_ADAPTIVE_CONCURRENCY_START ?? 3),
  max: Number(process.env.SCAN_ADAPTIVE_CONCURRENCY_MAX ?? 8),
  stableWindow: Number(process.env.SCAN_ADAPTIVE_CONCURRENCY_STABLE_WINDOW ?? 3),
};
const FABRIC_CUH_PER_DIUH = 1.5;
const FABRIC_CUH_PER_ORCHESTRATION_ACTIVITY_RUN = 0.0056;
const FABRIC_CUH_PER_MAPPING_DATAFLOW_VCORE_HOUR = 0.5;
const BYTES_PER_GIB = 1024 * 1024 * 1024;
const ARM_FETCH_TIMEOUT_MS = Number(process.env.SCAN_ARM_FETCH_TIMEOUT_MS ?? 60000);
const ARM_FETCH_MAX_RETRIES = Number(process.env.SCAN_ARM_FETCH_MAX_RETRIES ?? 5);
const BACKEND_AUTH_MODE = process.env.SCAN_AUTH_MODE === 'client-secret' ? 'client-secret' : 'azure-cli';

const ORCHESTRATION_ACTIVITY_TYPES = new Set([
  'appendvariable',
  'delete',
  'executepipeline',
  'fail',
  'filter',
  'foreach',
  'getmetadata',
  'ifcondition',
  'lookup',
  'setvariable',
  'switch',
  'until',
  'validation',
  'wait',
  'web',
]);

let cachedToken = null;
let confidentialClient = null;
let armRequestSequence = 0;

function utcNow() {
  return new Date().toISOString();
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function clampAdaptiveSettings(settings) {
  const minLimit = Math.max(1, Math.trunc(Number(settings?.min ?? DEFAULT_ADAPTIVE_CONCURRENCY.min)));
  const startLimit = Math.max(minLimit, Math.trunc(Number(settings?.start ?? DEFAULT_ADAPTIVE_CONCURRENCY.start)));
  const maxLimit = Math.max(startLimit, Math.trunc(Number(settings?.max ?? DEFAULT_ADAPTIVE_CONCURRENCY.max)));
  const stableWindowSize = Math.max(1, Math.trunc(Number(settings?.stableWindow ?? DEFAULT_ADAPTIVE_CONCURRENCY.stableWindow)));

  return {
    enabled: settings?.enabled !== false,
    min: minLimit,
    start: startLimit,
    max: maxLimit,
    stableWindow: stableWindowSize,
  };
}

function createAdaptiveConcurrencyController(initialLimit, minLimit, maxLimit, stableWindowSize, options = {}) {
  let currentLimit = clamp(initialLimit, minLimit, maxLimit);
  let cooldownUntil = 0;
  let stableSuccessCount = 0;
  const enabled = options.enabled !== false;
  const limitChangeListeners = new Set();

  function notifyLimitChange() {
    for (const listener of limitChangeListeners) {
      listener();
    }
  }

  return {
    isEnabled() {
      return enabled;
    },
    async waitForCooldown() {
      if (!enabled) {
        return;
      }

      const waitMs = Math.max(0, cooldownUntil - Date.now());
      if (waitMs > 0) {
        await delay(waitMs);
        notifyLimitChange();
      }
    },
    getLimit() {
      if (!enabled) {
        return clamp(currentLimit, minLimit, maxLimit);
      }

      const now = Date.now();
      const activeLimit = now < cooldownUntil ? Math.max(minLimit, currentLimit - 1) : currentLimit;
      return clamp(activeLimit, minLimit, maxLimit);
    },
    recordSuccess() {
      if (!enabled) {
        return;
      }

      stableSuccessCount += 1;
      if (stableSuccessCount >= stableWindowSize) {
        const previousLimit = currentLimit;
        currentLimit = clamp(currentLimit + 1, minLimit, maxLimit);
        stableSuccessCount = 0;
        if (currentLimit !== previousLimit) {
          options.onLimitChanged?.('stable-success', previousLimit, currentLimit, 0);
          notifyLimitChange();
        }
      }
    },
    recordThrottle(retryAfterMs) {
      if (!enabled) {
        return;
      }

      const throttleMs = Math.max(retryAfterMs ?? 1000, 1000);
      const previousLimit = currentLimit;
      currentLimit = Math.max(minLimit, Math.floor(currentLimit / 2));
      cooldownUntil = Math.max(cooldownUntil, Date.now() + throttleMs);
      stableSuccessCount = 0;
      if (currentLimit !== previousLimit) {
        options.onLimitChanged?.('throttle', previousLimit, currentLimit, throttleMs);
        notifyLimitChange();
      }
    },
    recordLowHeadroom() {
      if (!enabled) {
        return;
      }

      const previousLimit = currentLimit;
      currentLimit = Math.max(minLimit, Math.floor(currentLimit * 0.75));
      cooldownUntil = Math.max(cooldownUntil, Date.now() + 2000);
      stableSuccessCount = 0;
      if (currentLimit !== previousLimit) {
        options.onLimitChanged?.('low-rate-limit-headroom', previousLimit, currentLimit, 2000);
        notifyLimitChange();
      }
    },
    onLimitChange(listener) {
      limitChangeListeners.add(listener);
      return () => limitChangeListeners.delete(listener);
    },
  };
}

function createActivityQueryGate(controller, fixedLimit) {
  const normalizedFixedLimit = Math.max(1, Math.trunc(Number(fixedLimit) || 1));
  let activeCount = 0;
  const waiting = [];

  function getLimit() {
    return controller.isEnabled() ? controller.getLimit() : normalizedFixedLimit;
  }

  function drain() {
    while (waiting.length > 0 && activeCount < getLimit()) {
      activeCount += 1;
      waiting.shift()();
    }
  }

  controller.onLimitChange(drain);

  return {
    async run(worker) {
      await new Promise((resolve) => {
        waiting.push(resolve);
        drain();
      });

      try {
        return await worker();
      } finally {
        activeCount -= 1;
        drain();
      }
    },
  };
}

const adaptiveConcurrencyController = createAdaptiveConcurrencyController(
  DEFAULT_ADAPTIVE_CONCURRENCY.start,
  DEFAULT_ADAPTIVE_CONCURRENCY.min,
  DEFAULT_ADAPTIVE_CONCURRENCY.max,
  DEFAULT_ADAPTIVE_CONCURRENCY.stableWindow,
);

function createRunAdaptiveConcurrencyController(settings, logger) {
  const normalized = clampAdaptiveSettings(settings ?? DEFAULT_ADAPTIVE_CONCURRENCY);
  return createAdaptiveConcurrencyController(
    normalized.start,
    normalized.min,
    normalized.max,
    normalized.stableWindow,
    {
      enabled: normalized.enabled,
      onLimitChanged: (reason, previousLimit, currentLimit, cooldownMs) => {
        void logger?.info('adaptive-concurrency-changed', { reason, previousLimit, currentLimit, cooldownMs });
      },
    },
  );
}

function resolveAdaptiveConcurrency(baseConcurrency, controller = adaptiveConcurrencyController) {
  if (!controller || controller.isEnabled?.() === false) {
    return Math.max(1, baseConcurrency);
  }

  return Math.max(1, Math.min(baseConcurrency, controller.getLimit()));
}

function getLowRemainingRateLimit(headers) {
  const candidates = [
    'x-ms-ratelimit-remaining-subscription-reads',
    'x-ms-ratelimit-remaining-subscription-writes',
    'x-ms-ratelimit-remaining-subscription-deletes',
    'x-ms-ratelimit-remaining-tenant-reads',
    'x-ms-ratelimit-remaining-tenant-writes',
    'x-ms-ratelimit-remaining-tenant-deletes',
  ];

  let lowestRemaining = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const value = headers.get(candidate);
    if (value === null) {
      continue;
    }

    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      lowestRemaining = Math.min(lowestRemaining, parsed);
    }
  }

  return Number.isFinite(lowestRemaining) ? lowestRemaining : null;
}

function getRetryDelayMs(response, retryAttempt) {
  const retryAfterMsHeader = response.headers.get('x-ms-retry-after-ms') ?? response.headers.get('retry-after-ms');
  if (retryAfterMsHeader !== null) {
    const retryAfterMs = Number(retryAfterMsHeader);
    if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
      return retryAfterMs;
    }
  }

  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const retryAfterSeconds = Number(retryAfter);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
      return retryAfterSeconds * 1000;
    }

    const retryAt = new Date(retryAfter).getTime();
    if (Number.isFinite(retryAt)) {
      return Math.max(0, retryAt - Date.now());
    }
  }

  const exponentialDelay = Math.min(30000, 1000 * 2 ** retryAttempt);
  return exponentialDelay + Math.floor(Math.random() * 500);
}

function isTransientStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

function toDurationMinutes(startUtc, endUtc) {
  if (!startUtc || !endUtc) {
    return 0;
  }

  const start = new Date(startUtc).getTime();
  const end = new Date(endUtc).getTime();

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return 0;
  }

  return (end - start) / (1000 * 60);
}

function isOrchestrationActivityType(activityType) {
  return ORCHESTRATION_ACTIVITY_TYPES.has(activityType);
}

function parseDurationToMinutes(durationValue, unitValue) {
  const duration = toNumber(durationValue);
  if (duration <= 0) {
    return 0;
  }

  const unit = String(unitValue ?? '').toLowerCase();
  if (unit.includes('hour')) {
    return duration * 60;
  }

  if (unit.includes('minute')) {
    return duration;
  }

  if (unit.includes('second')) {
    return duration / 60;
  }

  if (unit.includes('millisecond')) {
    return duration / 60000;
  }

  return 0;
}

function sumBillableDurationMinutes(value) {
  if (!value) {
    return 0;
  }

  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + sumBillableDurationMinutes(item), 0);
  }

  if (typeof value !== 'object') {
    return 0;
  }

  const coreHours = toNumber(value.coreHours ?? value.vCoreHours ?? value.vcoreHours);
  if (coreHours > 0) {
    return coreHours * 60;
  }

  const vcoreMinutes = toNumber(value.vCoreMinutes ?? value.vcoreMinutes);
  if (vcoreMinutes > 0) {
    return vcoreMinutes;
  }

  return parseDurationToMinutes(value.duration ?? value.value ?? value.amount, value.unit ?? value.durationType ?? value.metricUnit);
}

function extractMappingDataflowVcoreMinutes(output) {
  if (!output || typeof output !== 'object') {
    return 0;
  }

  const directCandidates = [
    output.billingReference?.totalBillableDuration,
    output.billingReference?.billableDuration,
    output.runStatus?.billingReference?.totalBillableDuration,
    output.runStatus?.billingReference?.billableDuration,
  ];

  for (const candidate of directCandidates) {
    const minutes = sumBillableDurationMinutes(candidate);
    if (minutes > 0) {
      return minutes;
    }
  }

  if (Array.isArray(output.executionDetails)) {
    return output.executionDetails.reduce((sum, detail) => {
      const minutes = sumBillableDurationMinutes(detail?.billingReference?.totalBillableDuration)
        || sumBillableDurationMinutes(detail?.billingReference?.billableDuration);
      return sum + minutes;
    }, 0);
  }

  return 0;
}

function firstPositiveNumber(values) {
  for (const value of values) {
    const parsed = toNumber(value);
    if (parsed > 0) {
      return parsed;
    }
  }

  return 0;
}

function extractCopyDataMovementBytes(output) {
  if (!output || typeof output !== 'object') {
    return { readBytes: 0, writtenBytes: 0 };
  }

  const readBytes = firstPositiveNumber([
    output.dataRead,
    output.dataReadInBytes,
    output.bytesRead,
    output.sourceBytesRead,
  ]);

  const writtenBytes = firstPositiveNumber([
    output.dataWritten,
    output.dataWrittenInBytes,
    output.bytesWritten,
    output.sinkBytesWritten,
  ]);

  return {
    readBytes,
    writtenBytes,
  };
}

function normalizePipelineRun(pipelineRun) {
  return {
    pipelineRunId: String(pipelineRun.runId),
    pipelineName: pipelineRun.pipelineName ?? null,
    invokedByName: pipelineRun.invokedBy?.name ?? null,
    status: pipelineRun.status ?? null,
    runStartUtc: pipelineRun.runStart ?? null,
    runEndUtc: pipelineRun.runEnd ?? null,
    durationMinutes: toDurationMinutes(pipelineRun.runStart, pipelineRun.runEnd),
    parametersJson: pipelineRun.parameters ? JSON.stringify(pipelineRun.parameters) : null,
  };
}

function normalizeActivityRun(pipelineRunId, activityRun, activityIndex) {
  const output = activityRun.output ?? {};
  const copyDataMovement = extractCopyDataMovementBytes(output);
  const fallbackId = `${pipelineRunId}:${activityRun.activityName ?? 'activity'}:${activityRun.activityRunStart ?? activityIndex}`;

  return {
    pipelineRunId,
    activityRunId: String(activityRun.activityRunId ?? fallbackId),
    activityName: activityRun.activityName ?? null,
    activityType: activityRun.activityType ?? null,
    status: activityRun.status ?? null,
    activityStartUtc: activityRun.activityRunStart ?? null,
    activityEndUtc: activityRun.activityRunEnd ?? null,
    durationMs: toNumber(activityRun.durationInMs),
    usedDiu: toNumber(output.usedDataIntegrationUnits),
    copyDurationSeconds: toNumber(output.copyDuration),
    dataReadBytes: copyDataMovement.readBytes,
    dataWrittenBytes: copyDataMovement.writtenBytes,
    mappingDataflowVcoreMinutes: extractMappingDataflowVcoreMinutes(output),
    errorJson: activityRun.error ? JSON.stringify(activityRun.error) : null,
  };
}

function buildDayWindows(windowDays, endUtc) {
  const windows = [];
  const startUtc = new Date(endUtc.getTime() - windowDays * 24 * 60 * 60 * 1000);
  let cursor = new Date(startUtc);

  for (let i = 0; i < windowDays; i += 1) {
    const next = i === windowDays - 1 ? endUtc : new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    windows.push({
      label: cursor.toISOString().slice(0, 10),
      lastUpdatedAfter: cursor.toISOString(),
      lastUpdatedBefore: next.toISOString(),
    });
    cursor = next;
  }

  return windows;
}

async function mapWithConcurrency(items, concurrency, worker) {
  if (items.length === 0) {
    return [];
  }

  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runner() {
    while (true) {
      const currentIndex = nextIndex;
      if (currentIndex >= items.length) {
        return;
      }

      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex]);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runner()));
  return results;
}

function getClientSecretConfiguration() {
  const clientId = process.env.AZURE_CLIENT_ID?.trim();
  const tenantId = process.env.AZURE_TENANT_ID?.trim();
  const clientSecret = process.env.AZURE_CLIENT_SECRET?.trim();
  const missing = [
    !clientId ? 'AZURE_CLIENT_ID' : null,
    !tenantId ? 'AZURE_TENANT_ID' : null,
    !clientSecret ? 'AZURE_CLIENT_SECRET' : null,
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(`Client-secret authentication is missing: ${missing.join(', ')}.`);
  }

  return { clientId, tenantId, clientSecret };
}

async function getClientSecretAccessToken() {
  const config = getClientSecretConfiguration();
  confidentialClient ??= new ConfidentialClientApplication({
    auth: {
      clientId: config.clientId,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
      clientSecret: config.clientSecret,
    },
  });

  const result = await confidentialClient.acquireTokenByClientCredential({
    scopes: [`${ARM_ENDPOINT}/.default`],
  });
  if (!result?.accessToken) {
    throw new Error('Microsoft Entra did not return an ARM access token for the service principal.');
  }

  return {
    token: result.accessToken,
    expiresOn: result.expiresOn?.getTime() ?? Date.now() + 5 * 60 * 1000,
  };
}

async function getAzureCliAccessToken(logger) {
  await logger?.info('command-started', {
    command: 'az account get-access-token --resource https://management.azure.com/ --output json',
  });
  const startedAt = Date.now();
  const { stdout } = await execFileAsync('az', [
    'account',
    'get-access-token',
    '--resource',
    'https://management.azure.com/',
    '--output',
    'json',
  ]);
  await logger?.info('command-completed', {
    command: 'az account get-access-token',
    durationMs: Date.now() - startedAt,
  });

  const payload = JSON.parse(stdout);
  return {
    token: payload.accessToken,
    expiresOn: new Date(payload.expiresOn).getTime(),
  };
}

async function getAccessToken(logger) {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresOn > now + 2 * 60 * 1000) {
    return cachedToken.token;
  }

  cachedToken = BACKEND_AUTH_MODE === 'client-secret'
    ? await getClientSecretAccessToken()
    : await getAzureCliAccessToken(logger);

  return cachedToken.token;
}

export async function getBackendIdentity() {
  if (BACKEND_AUTH_MODE === 'client-secret') {
    const config = getClientSecretConfiguration();
    await getAccessToken();
    return {
      authMode: BACKEND_AUTH_MODE,
      displayName: `Service principal ${config.clientId}`,
      tenantId: config.tenantId,
      username: config.clientId,
    };
  }

  try {
    const { stdout } = await execFileAsync('az', ['account', 'show', '--output', 'json']);
    const account = JSON.parse(stdout);
    return {
      authMode: BACKEND_AUTH_MODE,
      displayName: String(account.name ?? ''),
      tenantId: String(account.tenantId ?? ''),
      username: String(account.user?.name ?? ''),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Azure CLI account lookup failed.';
    throw new Error(`No usable Azure CLI session was found. ${detail}`);
  }
}

async function armFetch(url, init, accessTokenOverride, controller = adaptiveConcurrencyController, logger) {
  const accessToken = accessTokenOverride ?? (await getAccessToken(logger));
  const timeoutMs = Number.isFinite(ARM_FETCH_TIMEOUT_MS) && ARM_FETCH_TIMEOUT_MS > 0 ? ARM_FETCH_TIMEOUT_MS : 60000;
  const maxRetries = Number.isFinite(ARM_FETCH_MAX_RETRIES) && ARM_FETCH_MAX_RETRIES >= 0
    ? Math.trunc(ARM_FETCH_MAX_RETRIES)
    : 5;
  const requestId = `arm-${Date.now()}-${++armRequestSequence}`;
  const method = init?.method ?? 'GET';
  let requestBody = init?.body;
  try {
    requestBody = typeof requestBody === 'string' ? JSON.parse(requestBody) : requestBody;
  } catch {
    // Keep a non-JSON body as text for diagnostics.
  }

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    await controller.waitForCooldown();
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
    let response;
    const attemptStartedAt = Date.now();
    await logger?.verbose('arm-request-started', {
      requestId,
      attempt: attempt + 1,
      maxAttempts: maxRetries + 1,
      method,
      url,
      requestBody,
      concurrencyLimit: controller.getLimit?.(),
      timeoutMs,
    });

    try {
      response = await fetch(url, {
        ...init,
        signal: abortController.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...(init?.headers ?? {}),
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await logger?.warn('arm-request-error', {
        requestId,
        attempt: attempt + 1,
        method,
        url,
        requestBody,
        durationMs: Date.now() - attemptStartedAt,
        errorName: error instanceof Error ? error.name : undefined,
        errorMessage,
        willRetry: attempt < maxRetries,
      });
      if (attempt < maxRetries) {
        const retryDelayMs = Math.min(30000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
        await logger?.info('arm-request-retry-scheduled', { requestId, retryDelayMs, reason: 'network-error' });
        await delay(retryDelayMs);
        continue;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Azure request timed out after ${maxRetries + 1} attempts of ${Math.round(timeoutMs / 1000)}s: ${url}`);
      }

      throw error;
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (response.ok) {
      const remainingRateLimit = getLowRemainingRateLimit(response.headers);
      await logger?.verbose('arm-request-completed', {
        requestId,
        attempt: attempt + 1,
        status: response.status,
        durationMs: Date.now() - attemptStartedAt,
        remainingRateLimit,
      });
      if (controller.isEnabled?.() !== false) {
        if (remainingRateLimit !== null && remainingRateLimit <= 10) {
          controller.recordLowHeadroom();
        } else {
          controller.recordSuccess();
        }
      }
      return response.json();
    }

    const body = await response.text();
    await logger?.warn('arm-request-failed', {
      requestId,
      attempt: attempt + 1,
      method,
      url,
      requestBody,
      status: response.status,
      durationMs: Date.now() - attemptStartedAt,
      responseBody: body.slice(0, 16384),
      transient: isTransientStatus(response.status),
      willRetry: isTransientStatus(response.status) && attempt < maxRetries,
    });
    if (!isTransientStatus(response.status) || attempt >= maxRetries) {
      throw new Error(`Azure request failed (${response.status}) after ${attempt + 1} attempt(s): ${body}`);
    }

    const retryDelayMs = getRetryDelayMs(response, attempt);
    if (controller.isEnabled?.() !== false) {
      controller.recordThrottle(retryDelayMs);
    }
    await logger?.info('arm-request-retry-scheduled', { requestId, retryDelayMs, reason: `http-${response.status}` });
    await delay(retryDelayMs);
  }

  throw new Error(`Azure request failed after ${maxRetries + 1} attempts: ${url}`);
}

export async function listAzureSubscriptions() {
  const payload = await armFetch(`${ARM_ENDPOINT}/subscriptions?api-version=2022-12-01`);
  const discoveredAtUtc = utcNow();
  return (payload.value ?? []).map((subscription) => ({
    id: subscription.subscriptionId,
    subscriptionId: subscription.subscriptionId,
    displayName: subscription.displayName,
    tenantId: subscription.tenantId,
    state: subscription.state,
    discoveredAtUtc,
  }));
}

export async function inventoryAzureFactories(subscriptionId) {
  const payload = await armFetch(`${ARM_ENDPOINT}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01`, {
    method: 'POST',
    body: JSON.stringify({
      subscriptions: [subscriptionId],
      query: "Resources | where type =~ 'microsoft.datafactory/factories' | project id, name, subscriptionId, resourceGroup, location, tags",
      options: { resultFormat: 'objectArray' },
    }),
  });
  const discoveredAtUtc = utcNow();
  return (payload.data ?? []).map((factory) => ({
    id: factory.id,
    name: factory.name,
    subscriptionId: factory.subscriptionId,
    resourceGroup: factory.resourceGroup,
    location: factory.location,
    discoveredAtUtc,
    tags: factory.tags,
  }));
}

async function queryPipelineRuns(subscriptionId, resourceGroup, factoryName, lastUpdatedAfter, lastUpdatedBefore, accessTokenOverride, controller = adaptiveConcurrencyController, logger) {
  const endpoint = `${ARM_ENDPOINT}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DataFactory/factories/${factoryName}/queryPipelineRuns?api-version=2018-06-01`;
  const runs = [];
  let continuationToken;
  let pageCount = 0;

  for (let i = 0; i < 20; i += 1) {
    const page = await armFetch(endpoint, {
      method: 'POST',
      body: JSON.stringify({ lastUpdatedAfter, lastUpdatedBefore, continuationToken }),
    }, accessTokenOverride, controller, logger);

    pageCount += 1;
    runs.push(...(page.value ?? []));
    if (!page.continuationToken) {
      break;
    }

    continuationToken = page.continuationToken;
  }

  return { runs, pageCount };
}

async function queryActivityRuns(subscriptionId, resourceGroup, factoryName, runId, lastUpdatedAfter, lastUpdatedBefore, accessTokenOverride, controller = adaptiveConcurrencyController, logger) {
  const endpoint = `${ARM_ENDPOINT}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DataFactory/factories/${factoryName}/pipelineruns/${runId}/queryActivityruns?api-version=2018-06-01`;
  const activityRuns = [];
  let continuationToken;
  let pageCount = 0;

  for (let i = 0; i < 20; i += 1) {
    const page = await armFetch(endpoint, {
      method: 'POST',
      body: JSON.stringify({ lastUpdatedAfter, lastUpdatedBefore, continuationToken }),
    }, accessTokenOverride, controller, logger);

    pageCount += 1;
    activityRuns.push(...(page.value ?? []));
    if (!page.continuationToken) {
      break;
    }

    continuationToken = page.continuationToken;
  }

  return { activityRuns, pageCount };
}

async function scanFactory(
  runId,
  factory,
  windowDays,
  accessTokenOverride,
  onProgress,
  controller = adaptiveConcurrencyController,
  activityQueryGate = createActivityQueryGate(controller, ACTIVITY_RUN_QUERY_CONCURRENCY),
  logger,
) {
  const now = new Date();
  const scanStartTime = Date.now();
  const effectiveWindowDays = Math.max(1, Math.min(7, Math.trunc(windowDays)));
  const dayWindows = buildDayWindows(effectiveWindowDays, now);
  await logger?.info('factory-scan-started', {
    factoryId: factory.id,
    factoryName: factory.name,
    subscriptionId: factory.subscriptionId,
    resourceGroup: factory.resourceGroup,
    windowDays: effectiveWindowDays,
    dayWindowCount: dayWindows.length,
  });

  const usageRecord = {
    id: `${runId}:${factory.id}`,
    runId,
    factoryId: factory.id,
    factoryName: factory.name,
    subscriptionId: factory.subscriptionId,
    windowDays: effectiveWindowDays,
    totalDayChunks: dayWindows.length,
    scannedDayChunks: 0,
    failedDayChunks: 0,
    activityRunCount: 0,
    orchestrationActivityRunCount: 0,
    mappingDataflowRunCount: 0,
    mappingDataflowVcoreMinutes: 0,
    copyRunCount: 0,
    copyDataReadBytes: 0,
    copyDataWrittenBytes: 0,
    copyDataMovedGiB: 0,
    pipelineRunCount: 0,
    pipelineExecutionMinutes: 0,
    externalPipelineExecutionMinutes: 0,
    totalDiuHours: 0,
    estimatedFabricCuhFromDiu: 0,
    estimatedFabricCuhFromOrchestration: 0,
    estimatedFabricCuhFromMappingDataflow: 0,
    estimatedFabricCuhTotal: 0,
    maxDailyEstimatedFabricCuh: 0,
    peakDailyCuRequired: 0,
    dailyMetrics: [],
    apiCallMetrics: { pipelineRunQueryCalls: 0, activityRunQueryCalls: 0, totalPipelineQueryPages: 0, totalActivityQueryPages: 0, scanStartTime },
    status: 'pending',
    note: `Scanning ${effectiveWindowDays}-day usage in ${dayWindows.length} day chunks...`,
    updatedAtUtc: utcNow(),
  };

  // Shared dedup set: safe across concurrent day tasks because JS processes microtasks
  // atomically — the synchronous filter+add runs entirely before any other task resumes.
  const seenPipelineRunIds = new Set();
  const dayChunkErrors = [];

  if (onProgress) {
    await onProgress({ ...usageRecord });
  }

  // Process all day windows in parallel. Each task aggregates into usageRecord synchronously
  // (no await between the mutations and the onProgress call, so tasks never interleave there).
  const adaptiveDayWindowConcurrency = resolveAdaptiveConcurrency(DAY_WINDOW_CONCURRENCY, controller);
  await mapWithConcurrency(dayWindows, adaptiveDayWindowConcurrency, async (dayWindow) => {
    upsertCheckpoint(runId, factory.id, dayWindow.label, 'running');
    await logger?.info('day-window-started', {
      factoryId: factory.id,
      factoryName: factory.name,
      metricDate: dayWindow.label,
      windowStartUtc: dayWindow.lastUpdatedAfter,
      windowEndUtc: dayWindow.lastUpdatedBefore,
    });

    try {
      const pipelineRunsResult = await queryPipelineRuns(
        factory.subscriptionId,
        factory.resourceGroup,
        factory.name,
        dayWindow.lastUpdatedAfter,
        dayWindow.lastUpdatedBefore,
        accessTokenOverride,
        controller,
        logger,
      );
      const pipelineRuns = pipelineRunsResult.runs;
      usageRecord.apiCallMetrics.pipelineRunQueryCalls += 1;
      usageRecord.apiCallMetrics.totalPipelineQueryPages += pipelineRunsResult.pageCount;

      // Dedup is safe: this synchronous block runs atomically between awaits.
      const newPipelineRuns = pipelineRuns.filter(
        (pipelineRun) => pipelineRun.runId && !seenPipelineRunIds.has(pipelineRun.runId),
      );
      for (const pipelineRun of newPipelineRuns) {
        seenPipelineRunIds.add(pipelineRun.runId);
      }

      upsertPipelineRuns(
        runId,
        factory.id,
        newPipelineRuns.map(normalizePipelineRun),
      );

      let chunkPipelineExecutionMinutes = 0;
      for (const pipelineRun of newPipelineRuns) {
        chunkPipelineExecutionMinutes += toDurationMinutes(pipelineRun.runStart, pipelineRun.runEnd);
      }

      const runActivityMetrics = await Promise.all(
        newPipelineRuns.map((pipelineRun) =>
          activityQueryGate.run(async () => {
            try {
              const activityRunsResult = await queryActivityRuns(
                factory.subscriptionId,
                factory.resourceGroup,
                factory.name,
                pipelineRun.runId,
                dayWindow.lastUpdatedAfter,
                dayWindow.lastUpdatedBefore,
                accessTokenOverride,
                controller,
                logger,
              );
              const activityRuns = activityRunsResult.activityRuns;
              usageRecord.apiCallMetrics.activityRunQueryCalls += 1;
              usageRecord.apiCallMetrics.totalActivityQueryPages += activityRunsResult.pageCount;

            upsertActivityRuns(
              runId,
              factory.id,
              activityRuns.map((activityRun, activityIndex) =>
                normalizeActivityRun(String(pipelineRun.runId), activityRun, activityIndex)),
            );

            let activityRunCount = activityRuns.length;
            let orchestrationActivityRunCount = 0;
            let copyRunCount = 0;
            let externalPipelineExecutionMinutes = 0;
            let totalDiuHours = 0;
            let mappingDataflowRunCount = 0;
            let totalMappingDataflowVcoreMinutes = 0;
            let totalCopyDataReadBytes = 0;
            let totalCopyDataWrittenBytes = 0;

            for (const activityRun of activityRuns) {
              const activityType = (activityRun.activityType ?? '').toLowerCase();

              if (isOrchestrationActivityType(activityType)) {
                orchestrationActivityRunCount += 1;
              }

              if (activityType === 'executedataflow') {
                mappingDataflowRunCount += 1;
                const mappingDataflowVcoreMinutes = extractMappingDataflowVcoreMinutes(activityRun.output);
                if (mappingDataflowVcoreMinutes > 0) {
                  totalMappingDataflowVcoreMinutes += mappingDataflowVcoreMinutes;
                }
              }

              if (activityType === 'executepipeline') {
                const externalDurationMs =
                  toNumber(activityRun.durationInMs) + toNumber(activityRun.output?.durationInMs);
                if (externalDurationMs > 0) {
                  externalPipelineExecutionMinutes += externalDurationMs / (1000 * 60);
                }
              }

              if (activityType !== 'copy') {
                continue;
              }

              copyRunCount += 1;
              const output = activityRun.output ?? {};
              const usedDiu = toNumber(output.usedDataIntegrationUnits);
              const copyDurationSeconds = toNumber(output.copyDuration);
              const copyDataMovement = extractCopyDataMovementBytes(output);
              if (usedDiu > 0 && copyDurationSeconds > 0) {
                totalDiuHours += (usedDiu * copyDurationSeconds) / 3600;
              }
              totalCopyDataReadBytes += copyDataMovement.readBytes;
              totalCopyDataWrittenBytes += copyDataMovement.writtenBytes;
            }

              return {
                activityRunCount,
                orchestrationActivityRunCount,
                copyRunCount,
                externalPipelineExecutionMinutes,
                totalDiuHours,
                mappingDataflowRunCount,
                totalMappingDataflowVcoreMinutes,
                totalCopyDataReadBytes,
                totalCopyDataWrittenBytes,
                failed: false,
              };
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : 'activity run query failed';
              await logger?.error('activity-query-failed', {
                factoryId: factory.id,
                metricDate: dayWindow.label,
                pipelineRunId: pipelineRun.runId,
                errorMessage,
                stack: error instanceof Error ? error.stack : undefined,
              });
              recordScanError(runId, factory.id, dayWindow.label, `activity-runs:${pipelineRun.runId}`, errorMessage);
              return {
                activityRunCount: 0,
                orchestrationActivityRunCount: 0,
                copyRunCount: 0,
                externalPipelineExecutionMinutes: 0,
                totalDiuHours: 0,
                mappingDataflowRunCount: 0,
                totalMappingDataflowVcoreMinutes: 0,
                totalCopyDataReadBytes: 0,
                totalCopyDataWrittenBytes: 0,
                failed: true,
                errorMessage,
              };
            }
          }),
        ),
      );

      let failedPipelineRunCountInChunk = 0;
      let chunkActivityRunCount = 0;
      let chunkOrchestrationActivityRunCount = 0;
      let chunkCopyRunCount = 0;
      let chunkMappingDataflowRunCount = 0;
      let chunkExternalPipelineExecutionMinutes = 0;
      let chunkDiuHours = 0;
      let chunkMappingDataflowVcoreMinutes = 0;
      let chunkCopyDataReadBytes = 0;
      let chunkCopyDataWrittenBytes = 0;
      const chunkErrors = [];

      for (const metrics of runActivityMetrics) {
        chunkActivityRunCount += metrics.activityRunCount;
        chunkOrchestrationActivityRunCount += metrics.orchestrationActivityRunCount;
        chunkCopyRunCount += metrics.copyRunCount;
        chunkExternalPipelineExecutionMinutes += metrics.externalPipelineExecutionMinutes;
        chunkDiuHours += metrics.totalDiuHours;
        chunkMappingDataflowRunCount += metrics.mappingDataflowRunCount;
        chunkMappingDataflowVcoreMinutes += metrics.totalMappingDataflowVcoreMinutes;
        chunkCopyDataReadBytes += metrics.totalCopyDataReadBytes;
        chunkCopyDataWrittenBytes += metrics.totalCopyDataWrittenBytes;

        if (metrics.failed) {
          failedPipelineRunCountInChunk += 1;
          if (metrics.errorMessage) {
            chunkErrors.push(`${dayWindow.label}: ${metrics.errorMessage}`);
          }
        }
      }

      if (failedPipelineRunCountInChunk > 0) {
        chunkErrors.push(`${dayWindow.label}: ${failedPipelineRunCountInChunk} pipeline activity-run queries failed`);
      }

      const chunkEstimatedFabricCuhFromDiu = chunkDiuHours * FABRIC_CUH_PER_DIUH;
      const chunkEstimatedFabricCuhFromOrchestration =
        chunkOrchestrationActivityRunCount * FABRIC_CUH_PER_ORCHESTRATION_ACTIVITY_RUN;
      const chunkEstimatedFabricCuhFromMappingDataflow =
        (chunkMappingDataflowVcoreMinutes / 60) * FABRIC_CUH_PER_MAPPING_DATAFLOW_VCORE_HOUR;
      const chunkEstimatedFabricCuhTotal =
        chunkEstimatedFabricCuhFromDiu + chunkEstimatedFabricCuhFromOrchestration + chunkEstimatedFabricCuhFromMappingDataflow;

      const chunkStatus = failedPipelineRunCountInChunk > 0 ? 'partial' : 'completed';

      upsertDailyMetric(runId, factory.id, {
        metricDate: dayWindow.label,
        windowStartUtc: dayWindow.lastUpdatedAfter,
        windowEndUtc: dayWindow.lastUpdatedBefore,
        pipelineRunCount: newPipelineRuns.length,
        activityRunCount: chunkActivityRunCount,
        orchestrationActivityRunCount: chunkOrchestrationActivityRunCount,
        copyRunCount: chunkCopyRunCount,
        mappingDataflowRunCount: chunkMappingDataflowRunCount,
        pipelineExecutionMinutes: chunkPipelineExecutionMinutes,
        externalPipelineExecutionMinutes: chunkExternalPipelineExecutionMinutes,
        totalDiuHours: chunkDiuHours,
        mappingDataflowVcoreMinutes: chunkMappingDataflowVcoreMinutes,
        copyDataReadBytes: chunkCopyDataReadBytes,
        copyDataWrittenBytes: chunkCopyDataWrittenBytes,
        estimatedFabricCuh: chunkEstimatedFabricCuhTotal,
        status: chunkStatus,
        updatedAtUtc: utcNow(),
      });
      upsertCheckpoint(runId, factory.id, dayWindow.label, chunkStatus);

      // Aggregate into usageRecord synchronously — no await between here and onProgress,
      // so concurrent day tasks never interleave within this block.
      usageRecord.pipelineRunCount += newPipelineRuns.length;
      usageRecord.pipelineExecutionMinutes += chunkPipelineExecutionMinutes;
      usageRecord.activityRunCount += chunkActivityRunCount;
      usageRecord.orchestrationActivityRunCount += chunkOrchestrationActivityRunCount;
      usageRecord.copyRunCount += chunkCopyRunCount;
      usageRecord.mappingDataflowRunCount += chunkMappingDataflowRunCount;
      usageRecord.externalPipelineExecutionMinutes += chunkExternalPipelineExecutionMinutes;
      usageRecord.totalDiuHours += chunkDiuHours;
      usageRecord.mappingDataflowVcoreMinutes += chunkMappingDataflowVcoreMinutes;
      usageRecord.copyDataReadBytes += chunkCopyDataReadBytes;
      usageRecord.copyDataWrittenBytes += chunkCopyDataWrittenBytes;
      dayChunkErrors.push(...chunkErrors);
      usageRecord.maxDailyEstimatedFabricCuh = Math.max(usageRecord.maxDailyEstimatedFabricCuh, chunkEstimatedFabricCuhTotal);
      usageRecord.peakDailyCuRequired = usageRecord.maxDailyEstimatedFabricCuh / 24;
      usageRecord.scannedDayChunks += 1;
      usageRecord.dailyMetrics.push({
        metricDate: dayWindow.label,
        estimatedFabricCuh: chunkEstimatedFabricCuhTotal,
        status: chunkStatus,
      });
      await logger?.info('day-window-completed', {
        factoryId: factory.id,
        metricDate: dayWindow.label,
        status: chunkStatus,
        pipelineRunCount: newPipelineRuns.length,
        activityRunCount: chunkActivityRunCount,
        failedActivityQueries: failedPipelineRunCountInChunk,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'chunk failed';
      await logger?.error('day-window-failed', {
        factoryId: factory.id,
        factoryName: factory.name,
        metricDate: dayWindow.label,
        errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      });
      recordScanError(runId, factory.id, dayWindow.label, 'day-chunk', errorMessage);
      upsertDailyMetric(runId, factory.id, {
        metricDate: dayWindow.label,
        windowStartUtc: dayWindow.lastUpdatedAfter,
        windowEndUtc: dayWindow.lastUpdatedBefore,
        pipelineRunCount: 0,
        activityRunCount: 0,
        orchestrationActivityRunCount: 0,
        copyRunCount: 0,
        mappingDataflowRunCount: 0,
        pipelineExecutionMinutes: 0,
        externalPipelineExecutionMinutes: 0,
        totalDiuHours: 0,
        mappingDataflowVcoreMinutes: 0,
        copyDataReadBytes: 0,
        copyDataWrittenBytes: 0,
        estimatedFabricCuh: 0,
        status: 'failed',
        updatedAtUtc: utcNow(),
      });
      upsertCheckpoint(runId, factory.id, dayWindow.label, 'failed');

      // Aggregate failure into usageRecord synchronously before onProgress.
      usageRecord.failedDayChunks += 1;
      dayChunkErrors.push(`${dayWindow.label}: ${errorMessage}`);
      usageRecord.dailyMetrics.push({
        metricDate: dayWindow.label,
        estimatedFabricCuh: 0,
        status: 'failed',
      });
    }

    usageRecord.estimatedFabricCuhFromDiu = usageRecord.totalDiuHours * FABRIC_CUH_PER_DIUH;
    usageRecord.estimatedFabricCuhFromOrchestration =
      usageRecord.orchestrationActivityRunCount * FABRIC_CUH_PER_ORCHESTRATION_ACTIVITY_RUN;
    usageRecord.estimatedFabricCuhFromMappingDataflow =
      (usageRecord.mappingDataflowVcoreMinutes / 60) * FABRIC_CUH_PER_MAPPING_DATAFLOW_VCORE_HOUR;
    usageRecord.estimatedFabricCuhTotal =
      usageRecord.estimatedFabricCuhFromDiu +
      usageRecord.estimatedFabricCuhFromOrchestration +
      usageRecord.estimatedFabricCuhFromMappingDataflow;
    const movedBytes = Math.max(usageRecord.copyDataReadBytes, usageRecord.copyDataWrittenBytes);
    usageRecord.copyDataMovedGiB = movedBytes > 0 ? movedBytes / BYTES_PER_GIB : 0;
    usageRecord.note = `Day chunks complete: ${usageRecord.scannedDayChunks}/${usageRecord.totalDayChunks}; failed: ${usageRecord.failedDayChunks}.`;
    usageRecord.updatedAtUtc = utcNow();

    if (onProgress) {
      await onProgress({ ...usageRecord });
    }
  });

  // Restore date order — parallel tasks may complete out of order.
  usageRecord.dailyMetrics.sort((a, b) => a.metricDate.localeCompare(b.metricDate));

  usageRecord.status = usageRecord.failedDayChunks > 0 || dayChunkErrors.length > 0 ? 'failed' : 'collected';
  if (dayChunkErrors.length > 0) {
    usageRecord.note = `${usageRecord.note} Failed chunks: ${dayChunkErrors.join(' | ')}`;
  }

  // Calculate throughput metrics
  const scanDurationMs = Date.now() - usageRecord.apiCallMetrics.scanStartTime;
  const totalApiCalls = usageRecord.apiCallMetrics.totalPipelineQueryPages + usageRecord.apiCallMetrics.totalActivityQueryPages;
  const avgCallsPerSecond = totalApiCalls > 0 ? (totalApiCalls / Math.max(scanDurationMs, 1) * 1000).toFixed(2) : '0';
  const avgCallDurationMs = totalApiCalls > 0 ? (scanDurationMs / totalApiCalls).toFixed(0) : '0';

  usageRecord.apiCallMetrics.scanDurationMs = scanDurationMs;
  usageRecord.apiCallMetrics.totalApiCalls = totalApiCalls;
  usageRecord.apiCallMetrics.avgCallsPerSecond = parseFloat(avgCallsPerSecond);
  usageRecord.apiCallMetrics.avgCallDurationMs = parseFloat(avgCallDurationMs);
  usageRecord.note = `${usageRecord.note} | Throughput: ${totalApiCalls} API calls (${avgCallsPerSecond}/sec, ${avgCallDurationMs}ms/call).`;

  console.log(`✓ ${usageRecord.factoryName}: ${usageRecord.note}`);
  await logger?.info('factory-scan-completed', {
    factoryId: factory.id,
    factoryName: factory.name,
    status: usageRecord.status,
    scannedDayChunks: usageRecord.scannedDayChunks,
    failedDayChunks: usageRecord.failedDayChunks,
    totalApiCalls,
    scanDurationMs,
    avgCallsPerSecond: usageRecord.apiCallMetrics.avgCallsPerSecond,
  });

  usageRecord.updatedAtUtc = utcNow();
  return usageRecord;
}

export async function scanFactories(runId, factories, windowDays, accessTokenOverride, onProgress, adaptiveSettings = DEFAULT_ADAPTIVE_CONCURRENCY, logger) {
  const normalizedAdaptiveSettings = clampAdaptiveSettings(adaptiveSettings);
  const adaptiveController = createRunAdaptiveConcurrencyController(normalizedAdaptiveSettings, logger);
  const activityQueryGate = createActivityQueryGate(adaptiveController, ACTIVITY_RUN_QUERY_CONCURRENCY);
  const adaptiveFactoryConcurrency = resolveAdaptiveConcurrency(FACTORY_SCAN_CONCURRENCY, adaptiveController);
  await logger?.info('scan-runtime-settings', {
    authMode: accessTokenOverride ? 'forwarded-access-token' : BACKEND_AUTH_MODE,
    factoryCount: factories.length,
    windowDays,
    factoryScanConcurrency: FACTORY_SCAN_CONCURRENCY,
    effectiveFactoryScanConcurrency: adaptiveFactoryConcurrency,
    dayWindowConcurrency: DAY_WINDOW_CONCURRENCY,
    effectiveDayWindowConcurrency: resolveAdaptiveConcurrency(DAY_WINDOW_CONCURRENCY, adaptiveController),
    activityRunQueryConcurrency: ACTIVITY_RUN_QUERY_CONCURRENCY,
    adaptive: normalizedAdaptiveSettings,
    armFetchTimeoutMs: ARM_FETCH_TIMEOUT_MS,
    armFetchMaxRetries: ARM_FETCH_MAX_RETRIES,
    nodeVersion: process.version,
    platform: process.platform,
    processId: process.pid,
  });
  return mapWithConcurrency(factories, adaptiveFactoryConcurrency, async (factory) =>
    scanFactory(runId, factory, windowDays, accessTokenOverride, onProgress, adaptiveController, activityQueryGate, logger),
  );
}
