import { createServer } from 'node:http';
import { URL } from 'node:url';
import { getBackendIdentity, inventoryAzureFactories, listAzureSubscriptions, scanFactories } from './azureScanner.js';
import { createScanLogger, getScanLogFileName, readScanLog } from './scanLogger.js';
import {
  createRun,
  getRun,
  getUsage,
  listRuns,
  recordScanError,
  registerFactories,
  updateRun,
  upsertUsage,
} from './state.js';

const port = Number(process.env.PORT ?? 7071);
const host = (process.env.HOST ?? '127.0.0.1').trim();
const allowedOrigin = (process.env.SCAN_API_ALLOWED_ORIGIN ?? 'http://localhost:5173').trim();

function logRunAction(runId, action) {
  // eslint-disable-next-line no-console
  console.log(`[run:${runId}] ${action}`);
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function isFactoryInput(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.subscriptionId === 'string' &&
    typeof value.resourceGroup === 'string' &&
    typeof value.location === 'string'
  );
}

function normalizeCreateRunRequest(body) {
  if (!body || typeof body !== 'object') {
    throw new Error('Request body must be a JSON object.');
  }

  const factoriesRaw = body.factories;
  const windowDaysRaw = body.windowDays;
  const accessTokenRaw = body.accessToken;
  const adaptiveRaw = body.adaptive;
  const factoryConcurrencyRaw = body.factoryConcurrency;

  if (body.traceLogEnabled !== undefined && typeof body.traceLogEnabled !== 'boolean') {
    throw new Error('traceLogEnabled must be a boolean when provided.');
  }
  const traceLogEnabled = body.traceLogEnabled ?? true;

  if (body.traceVerboseEnabled !== undefined && typeof body.traceVerboseEnabled !== 'boolean') {
    throw new Error('traceVerboseEnabled must be a boolean when provided.');
  }
  const traceVerboseEnabled = body.traceVerboseEnabled ?? false;

  if (!Array.isArray(factoriesRaw) || factoriesRaw.length === 0) {
    throw new Error('factories must be a non-empty array.');
  }

  const factories = factoriesRaw.filter(isFactoryInput);
  if (factories.length !== factoriesRaw.length) {
    throw new Error('Each factory entry must include id, name, subscriptionId, resourceGroup, and location.');
  }

  const windowDays = typeof windowDaysRaw === 'number' ? Math.trunc(windowDaysRaw) : 7;
  if (windowDays < 1 || windowDays > 7) {
    throw new Error('windowDays must be between 1 and 7.');
  }

  if (accessTokenRaw !== undefined && typeof accessTokenRaw !== 'string') {
    throw new Error('accessToken must be a string when provided.');
  }

  const accessToken = typeof accessTokenRaw === 'string' && accessTokenRaw.trim().length > 0 ? accessTokenRaw.trim() : undefined;

  let factoryConcurrency;
  if (factoryConcurrencyRaw !== undefined) {
    factoryConcurrency = Number(factoryConcurrencyRaw);
    if (!Number.isFinite(factoryConcurrency) || Math.trunc(factoryConcurrency) !== factoryConcurrency || factoryConcurrency < 1 || factoryConcurrency > 10) {
      throw new Error('factoryConcurrency must be a whole number between 1 and 10.');
    }
  }

  let adaptive = undefined;
  if (adaptiveRaw !== undefined) {
    if (adaptiveRaw === null || typeof adaptiveRaw !== 'object') {
      throw new Error('adaptive must be an object when provided.');
    }

    const enabled = adaptiveRaw.enabled === undefined ? true : Boolean(adaptiveRaw.enabled);
    const toInt = (value, fallback, label) => {
      const parsed = Number(value ?? fallback);
      if (!Number.isFinite(parsed) || Math.trunc(parsed) !== parsed || parsed < 1) {
        throw new Error(`${label} must be a whole number greater than or equal to 1.`);
      }
      return parsed;
    };

    const min = toInt(adaptiveRaw.min, 1, 'adaptive.min');
    const start = toInt(adaptiveRaw.start, 3, 'adaptive.start');
    const max = toInt(adaptiveRaw.max, 8, 'adaptive.max');
    const stableWindow = toInt(adaptiveRaw.stableWindow, 3, 'adaptive.stableWindow');

    if (min > start) {
      throw new Error('adaptive.min cannot be larger than adaptive.start.');
    }

    if (start > max) {
      throw new Error('adaptive.start cannot be larger than adaptive.max.');
    }

    adaptive = {
      enabled,
      min,
      start,
      max,
      stableWindow,
    };
  }

  return { factories, windowDays, accessToken, adaptive, factoryConcurrency, traceLogEnabled, traceVerboseEnabled };
}

function getRunIdFromPath(pathname, suffix) {
  if (!pathname.endsWith(suffix)) {
    return null;
  }

  const parts = pathname.split('/');
  if (parts.length < 4) {
    return null;
  }

  return parts[3] || null;
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk.toString('utf8');
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error('Payload too large.'));
      }
    });

    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON body.'));
      }
    });

    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  if (!req.url || !req.method) {
    sendJson(res, 400, { error: 'Invalid request.' });
    return;
  }

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  const url = new URL(req.url, `http://localhost:${port}`);
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/health') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/azure/account') {
    try {
      sendJson(res, 200, await getBackendIdentity());
    } catch (error) {
      sendJson(res, 401, { error: error instanceof Error ? error.message : 'Backend authentication failed.' });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/azure/subscriptions') {
    try {
      sendJson(res, 200, await listAzureSubscriptions());
    } catch (error) {
      sendJson(res, 502, { error: error instanceof Error ? error.message : 'Subscription discovery failed.' });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/azure/factories') {
    try {
      const body = await readJsonBody(req);
      if (!body || typeof body.subscriptionId !== 'string' || body.subscriptionId.trim().length === 0) {
        throw new Error('subscriptionId must be a non-empty string.');
      }
      sendJson(res, 200, await inventoryAzureFactories(body.subscriptionId.trim()));
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'Factory inventory failed.' });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/runs') {
    sendJson(res, 200, { runs: listRuns() });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/runs') {
    try {
      const body = await readJsonBody(req);
      const payload = normalizeCreateRunRequest(body);
      const run = createRun(payload.windowDays, payload.factories.length);
      const logger = payload.traceLogEnabled
        ? await createScanLogger(run.runId, { verbose: payload.traceVerboseEnabled })
        : undefined;
      await logger?.info('scan-batch-created', {
        windowDays: payload.windowDays,
        factoryCount: payload.factories.length,
        factoryConcurrency: payload.factoryConcurrency,
        traceVerboseEnabled: payload.traceVerboseEnabled,
        adaptive: payload.adaptive,
        factories: payload.factories.map((factory) => ({
          id: factory.id,
          name: factory.name,
          subscriptionId: factory.subscriptionId,
          resourceGroup: factory.resourceGroup,
          location: factory.location,
        })),
      });
      registerFactories(run.runId, payload.factories);
      logRunAction(run.runId, `Queued usage scan for ${payload.factories.length} factories over ${payload.windowDays} days.`);

      void (async () => {
        updateRun(run.runId, (current) => ({
          ...current,
          status: 'running',
          startedAtUtc: new Date().toISOString(),
          message: `Scanning ${payload.factories.length} factories over ${payload.windowDays} days.`,
        }));
        logRunAction(run.runId, 'Run started.');
        await logger?.info('scan-started');

        try {
          const results = await scanFactories(
            run.runId,
            payload.factories,
            payload.windowDays,
            payload.accessToken,
            async (usage) => {
            upsertUsage(run.runId, usage);
            logRunAction(
              run.runId,
              `Factory ${usage.factoryName} status=${usage.status}; chunks ${usage.scannedDayChunks}/${usage.totalDayChunks}; failed chunks ${usage.failedDayChunks}.`,
            );

            updateRun(run.runId, (current) => {
              const currentUsage = getUsage(run.runId);
              const completedFactoryCount = currentUsage.filter((row) => row.status === 'collected' || row.status === 'failed').length;
              const failedFactoryCount = currentUsage.filter((row) => row.status === 'failed').length;
              const scannedDayChunks = currentUsage.reduce((sum, row) => sum + row.scannedDayChunks, 0);
              const totalDayChunks = currentUsage.reduce((sum, row) => sum + row.totalDayChunks, 0);

              return {
                ...current,
                completedFactoryCount,
                failedFactoryCount,
                scannedDayChunks,
                totalDayChunks,
                message: `Completed factories: ${completedFactoryCount}/${current.factoryCount}`,
              };
            });

            const currentUsage = getUsage(run.runId);
            const completedFactoryCount = currentUsage.filter((row) => row.status === 'collected' || row.status === 'failed').length;
            logRunAction(run.runId, `Progress: factories ${completedFactoryCount}/${run.factoryCount}.`);
            },
            payload.adaptive,
            payload.factoryConcurrency,
            logger,
          );

          results.forEach((result) => upsertUsage(run.runId, result));
          const finalizedUsage = getUsage(run.runId);
          const completedFactoryCount = finalizedUsage.filter(
            (row) => row.status === 'collected' || row.status === 'failed',
          ).length;
          const failedFactoryCount = finalizedUsage.filter((row) => row.status === 'failed').length;
          const scannedDayChunks = finalizedUsage.reduce((sum, row) => sum + row.scannedDayChunks, 0);

          const finalizedRun = updateRun(run.runId, (current) => ({
            ...current,
            status: failedFactoryCount > 0 ? 'failed' : 'completed',
            completedFactoryCount,
            failedFactoryCount,
            scannedDayChunks,
            completedAtUtc: new Date().toISOString(),
            message:
              failedFactoryCount > 0
                ? `Run completed with ${failedFactoryCount} failed factories.`
                : 'Run completed successfully.',
          }));

          if (finalizedRun?.status === 'failed') {
            logRunAction(run.runId, `Run completed with failures (${finalizedRun.failedFactoryCount}/${finalizedRun.factoryCount}).`);
          } else {
            logRunAction(run.runId, `Run completed successfully (${finalizedRun?.completedFactoryCount ?? 0}/${finalizedRun?.factoryCount ?? 0}).`);
          }
          await logger?.info('scan-completed', {
            status: finalizedRun?.status,
            completedFactoryCount: finalizedRun?.completedFactoryCount,
            failedFactoryCount: finalizedRun?.failedFactoryCount,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unexpected scan error.';
          await logger?.error('scan-failed', {
            errorMessage,
            stack: error instanceof Error ? error.stack : undefined,
          });
          recordScanError(run.runId, null, null, 'run', errorMessage);
          updateRun(run.runId, (current) => ({
            ...current,
            status: 'failed',
            completedAtUtc: new Date().toISOString(),
            message: 'Run failed.',
            lastError: errorMessage,
          }));
          logRunAction(run.runId, `Run failed: ${errorMessage}`);
        } finally {
          await logger?.flush();
        }
      })();

      sendJson(res, 202, {
        runId: run.runId,
        status: run.status,
        logUrl: payload.traceLogEnabled ? `/api/runs/${run.runId}/log` : undefined,
      });
      return;
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid request.' });
      return;
    }
  }

  if (req.method === 'GET' && pathname.startsWith('/api/runs/') && pathname.endsWith('/status')) {
    const runId = getRunIdFromPath(pathname, '/status');
    if (!runId) {
      sendJson(res, 404, { error: 'Run not found.' });
      return;
    }

    const run = getRun(runId);
    if (!run) {
      sendJson(res, 404, { error: 'Run not found.' });
      return;
    }

    sendJson(res, 200, { run });
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/runs/') && pathname.endsWith('/results')) {
    const runId = getRunIdFromPath(pathname, '/results');
    if (!runId) {
      sendJson(res, 404, { error: 'Run not found.' });
      return;
    }

    const run = getRun(runId);
    if (!run) {
      sendJson(res, 404, { error: 'Run not found.' });
      return;
    }

    sendJson(res, 200, { run, usage: getUsage(runId) });
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/runs/') && pathname.endsWith('/log')) {
    const runId = getRunIdFromPath(pathname, '/log');
    if (!runId || !getRun(runId)) {
      sendJson(res, 404, { error: 'Run not found.' });
      return;
    }

    try {
      const body = await readScanLog(runId);
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Content-Disposition': `attachment; filename="${getScanLogFileName(runId)}"`,
        'Access-Control-Allow-Origin': allowedOrigin,
      });
      res.end(body);
    } catch (error) {
      const errorCode = error && typeof error === 'object' ? error.code : undefined;
      sendJson(res, errorCode === 'ENOENT' ? 404 : 500, {
        error: errorCode === 'ENOENT' ? 'Scan log not found.' : 'Scan log could not be read.',
      });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found.' });
});

server.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`ADF scan API listening on http://${host}:${port}`);
});
