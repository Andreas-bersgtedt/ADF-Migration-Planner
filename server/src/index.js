import { createServer } from 'node:http';
import { URL } from 'node:url';
import { getBackendIdentity, inventoryAzureFactories, listAzureSubscriptions, scanFactories } from './azureScanner.js';
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

  return { factories, windowDays, accessToken };
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

        try {
          const results = await scanFactories(run.runId, payload.factories, payload.windowDays, payload.accessToken, async (usage) => {
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
          });

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
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unexpected scan error.';
          recordScanError(run.runId, null, null, 'run', errorMessage);
          updateRun(run.runId, (current) => ({
            ...current,
            status: 'failed',
            completedAtUtc: new Date().toISOString(),
            message: 'Run failed.',
            lastError: errorMessage,
          }));
          logRunAction(run.runId, `Run failed: ${errorMessage}`);
        }
      })();

      sendJson(res, 202, { runId: run.runId, status: run.status });
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

  sendJson(res, 404, { error: 'Not found.' });
});

server.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`ADF scan API listening on http://${host}:${port}`);
});
