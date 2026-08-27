import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const databasePath = resolve('server', 'data', `resume-scan-test-${process.pid}.sqlite`);
process.env.SCAN_DATABASE_PATH = databasePath;
process.env.SCAN_ARM_FETCH_MAX_RETRIES = '0';
process.env.SCAN_DAY_WINDOW_CONCURRENCY = '1';
process.env.SCAN_ACTIVITY_QUERY_CONCURRENCY = '1';

test('resume scans only incomplete chunks and preserves completed totals', async (context) => {
  const state = await import('../src/state.js');
  const { database } = await import('../src/database.js');
  const { buildDayWindows, scanFactories } = await import('../src/azureScanner.js');
  const originalFetch = globalThis.fetch;
  let failSecondDay = true;
  const pipelineQueriesByStart = new Map();

  context.after(async () => {
    globalThis.fetch = originalFetch;
    database.close();
    await Promise.all([
      rm(databasePath, { force: true }),
      rm(`${databasePath}-wal`, { force: true }),
      rm(`${databasePath}-shm`, { force: true }),
    ]);
  });

  globalThis.fetch = async (url, init) => {
    const requestUrl = String(url);
    const body = JSON.parse(String(init?.body ?? '{}'));

    if (requestUrl.includes('/queryPipelineRuns')) {
      const start = body.lastUpdatedAfter;
      pipelineQueriesByStart.set(start, (pipelineQueriesByStart.get(start) ?? 0) + 1);
      if (start.startsWith('2026-08-26') && failSecondDay) {
        return new Response(JSON.stringify({ error: { code: 'TooManyRequests' } }), {
          status: 429,
          headers: { 'Retry-After': '0' },
        });
      }

      const suffix = start.startsWith('2026-08-25') ? 'one' : 'two';
      return Response.json({
        value: [{
          runId: `pipeline-${suffix}`,
          pipelineName: `pipeline-${suffix}`,
          status: 'Succeeded',
          runStart: start,
          runEnd: new Date(new Date(start).getTime() + 60_000).toISOString(),
        }],
      });
    }

    if (requestUrl.includes('/queryActivityruns')) {
      return Response.json({
        value: [{
          activityRunId: `activity-${requestUrl.includes('pipeline-one') ? 'one' : 'two'}`,
          activityName: 'copy',
          activityType: 'Copy',
          status: 'Succeeded',
          durationInMs: 3_600_000,
          output: { usedDataIntegrationUnits: 2, copyDuration: 3600 },
        }],
      });
    }

    throw new Error(`Unexpected request: ${requestUrl}`);
  };

  const factories = [{
    id: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.DataFactory/factories/factory-1',
    name: 'factory-1',
    subscriptionId: 'sub-1',
    resourceGroup: 'rg',
    location: 'eastus',
  }];
  const run = state.createRun(2, 1, { scanEndUtc: '2026-08-27T00:00:00.000Z' });
  const windows = buildDayWindows(2, new Date(run.scanEndUtc));
  state.registerFactories(run.runId, factories);
  state.initializeCheckpoints(run.runId, factories, windows);

  const firstResults = await scanFactories(
    run.runId,
    factories,
    2,
    'test-token',
    undefined,
    { enabled: false, min: 1, start: 1, max: 1, stableWindow: 1 },
    1,
    undefined,
    { mode: 'all' },
  );

  assert.equal(firstResults[0].status, 'failed');
  assert.equal(firstResults[0].scannedDayChunks, 1);
  assert.equal(firstResults[0].failedDayChunks, 1);
  assert.equal(firstResults[0].totalDiuHours, 2);

  failSecondDay = false;
  const resumedResults = await scanFactories(
    run.runId,
    factories,
    2,
    'test-token',
    undefined,
    { enabled: false, min: 1, start: 1, max: 1, stableWindow: 1 },
    1,
    undefined,
    { mode: 'failed-and-missing' },
  );

  assert.equal(resumedResults[0].status, 'collected');
  assert.equal(resumedResults[0].scannedDayChunks, 2);
  assert.equal(resumedResults[0].failedDayChunks, 0);
  assert.equal(resumedResults[0].totalDiuHours, 4);
  assert.equal(pipelineQueriesByStart.get('2026-08-25T00:00:00.000Z'), 1);
  assert.equal(pipelineQueriesByStart.get('2026-08-26T00:00:00.000Z'), 2);

  state.updateRun(run.runId, (current) => ({ ...current, status: 'running' }));
  state.upsertCheckpoint(run.runId, factories[0].id, '2026-08-26', 'running');
  assert.deepEqual(state.recoverInterruptedRuns(), [run.runId]);
  assert.equal(state.getRun(run.runId).status, 'paused');
  assert.equal(
    state.listCheckpoints(run.runId).find((checkpoint) => checkpoint.metricDate === '2026-08-26').status,
    'pending',
  );

  let pageCount = 0;
  globalThis.fetch = async (url) => {
    if (!String(url).includes('/queryPipelineRuns')) {
      throw new Error(`Unexpected request: ${url}`);
    }

    pageCount += 1;
    return Response.json({
      value: [],
      ...(pageCount < 21 ? { continuationToken: `page-${pageCount + 1}` } : {}),
    });
  };

  const pagedFactory = { ...factories[0], id: `${factories[0].id}-paged`, name: 'factory-paged' };
  const pagedRun = state.createRun(1, 1, { scanEndUtc: '2026-08-27T00:00:00.000Z' });
  state.registerFactories(pagedRun.runId, [pagedFactory]);
  state.initializeCheckpoints(pagedRun.runId, [pagedFactory], buildDayWindows(1, new Date(pagedRun.scanEndUtc)));
  const pagedResults = await scanFactories(
    pagedRun.runId,
    [pagedFactory],
    1,
    'test-token',
    undefined,
    { enabled: false, min: 1, start: 1, max: 1, stableWindow: 1 },
    1,
    undefined,
    { mode: 'all' },
  );

  assert.equal(pageCount, 21);
  assert.equal(pagedResults[0].status, 'collected');
});