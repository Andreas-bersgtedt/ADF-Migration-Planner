import { database } from './database.js';

const MAX_RETAINED_RUNS = Number(process.env.SCAN_MAX_RETAINED_RUNS ?? 50);

function utcNow() {
  return new Date().toISOString();
}

function createId(prefix) {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now()}-${random}`;
}

function parsePayload(row) {
  return row ? JSON.parse(row.payload_json) : undefined;
}

const insertRun = database.prepare(`
  INSERT INTO runs (run_id, created_at_utc, status, payload_json)
  VALUES (@runId, @createdAtUtc, @status, @payloadJson)
  ON CONFLICT(run_id) DO UPDATE SET status = excluded.status, payload_json = excluded.payload_json
`);

function saveRun(run) {
  insertRun.run({
    runId: run.runId,
    createdAtUtc: run.createdAtUtc,
    status: run.status,
    payloadJson: JSON.stringify(run),
  });
  return run;
}

function pruneOldRuns() {
  const cap = Number.isFinite(MAX_RETAINED_RUNS) && MAX_RETAINED_RUNS > 0 ? Math.trunc(MAX_RETAINED_RUNS) : 50;
  const staleRows = database.prepare(`
    SELECT run_id FROM runs ORDER BY created_at_utc DESC LIMIT -1 OFFSET ?
  `).all(cap);
  const deleteRun = database.prepare('DELETE FROM runs WHERE run_id = ?');

  database.transaction((rows) => {
    for (const row of rows) {
      deleteRun.run(row.run_id);
    }
  })(staleRows);
}

export function createRun(windowDays, factoryCount) {
  const run = {
    runId: createId('run'),
    createdAtUtc: utcNow(),
    status: 'queued',
    windowDays,
    factoryCount,
    completedFactoryCount: 0,
    failedFactoryCount: 0,
    scannedDayChunks: 0,
    totalDayChunks: factoryCount * windowDays,
    message: 'Run queued.',
  };

  saveRun(run);
  pruneOldRuns();
  return run;
}

export function registerFactories(runId, factories) {
  const statement = database.prepare(`
    INSERT INTO factories (run_id, factory_id, subscription_id, resource_group, factory_name, location)
    VALUES (@runId, @factoryId, @subscriptionId, @resourceGroup, @factoryName, @location)
    ON CONFLICT(run_id, factory_id) DO UPDATE SET
      subscription_id = excluded.subscription_id,
      resource_group = excluded.resource_group,
      factory_name = excluded.factory_name,
      location = excluded.location
  `);

  database.transaction((rows) => {
    for (const factory of rows) {
      statement.run({
        runId,
        factoryId: factory.id,
        subscriptionId: factory.subscriptionId,
        resourceGroup: factory.resourceGroup,
        factoryName: factory.name,
        location: factory.location,
      });
    }
  })(factories);
}

export function getRun(runId) {
  return parsePayload(database.prepare('SELECT payload_json FROM runs WHERE run_id = ?').get(runId));
}

export function getUsage(runId) {
  return database.prepare(`
    SELECT payload_json FROM factory_usage WHERE run_id = ? ORDER BY updated_at_utc DESC, factory_id
  `).all(runId).map(parsePayload);
}

export function updateRun(runId, updater) {
  const run = getRun(runId);
  return run ? saveRun(updater(run)) : undefined;
}

export function upsertUsage(runId, record) {
  database.prepare(`
    INSERT INTO factory_usage (run_id, factory_id, subscription_id, status, updated_at_utc, payload_json)
    VALUES (@runId, @factoryId, @subscriptionId, @status, @updatedAtUtc, @payloadJson)
    ON CONFLICT(run_id, factory_id) DO UPDATE SET
      subscription_id = excluded.subscription_id,
      status = excluded.status,
      updated_at_utc = excluded.updated_at_utc,
      payload_json = excluded.payload_json
  `).run({
    runId,
    factoryId: record.factoryId,
    subscriptionId: record.subscriptionId,
    status: record.status,
    updatedAtUtc: record.updatedAtUtc,
    payloadJson: JSON.stringify(record),
  });
}

export function listRuns() {
  return database.prepare('SELECT payload_json FROM runs ORDER BY created_at_utc DESC').all().map(parsePayload);
}

export function upsertPipelineRuns(runId, factoryId, pipelineRuns) {
  const statement = database.prepare(`
    INSERT INTO pipeline_runs (
      run_id, factory_id, pipeline_run_id, pipeline_name, invoked_by_name, status,
      run_start_utc, run_end_utc, duration_minutes, parameters_json
    ) VALUES (
      @runId, @factoryId, @pipelineRunId, @pipelineName, @invokedByName, @status,
      @runStartUtc, @runEndUtc, @durationMinutes, @parametersJson
    )
    ON CONFLICT(run_id, factory_id, pipeline_run_id) DO UPDATE SET
      pipeline_name = excluded.pipeline_name,
      invoked_by_name = excluded.invoked_by_name,
      status = excluded.status,
      run_start_utc = excluded.run_start_utc,
      run_end_utc = excluded.run_end_utc,
      duration_minutes = excluded.duration_minutes,
      parameters_json = excluded.parameters_json
  `);

  database.transaction((rows) => {
    for (const row of rows) {
      statement.run({ runId, factoryId, ...row });
    }
  })(pipelineRuns);
}

export function upsertActivityRuns(runId, factoryId, activityRuns) {
  const statement = database.prepare(`
    INSERT INTO activity_runs (
      run_id, factory_id, pipeline_run_id, activity_run_id, activity_name, activity_type, status,
      activity_start_utc, activity_end_utc, duration_ms, used_diu, copy_duration_seconds,
      data_read_bytes, data_written_bytes, mapping_dataflow_vcore_minutes, error_json
    ) VALUES (
      @runId, @factoryId, @pipelineRunId, @activityRunId, @activityName, @activityType, @status,
      @activityStartUtc, @activityEndUtc, @durationMs, @usedDiu, @copyDurationSeconds,
      @dataReadBytes, @dataWrittenBytes, @mappingDataflowVcoreMinutes, @errorJson
    )
    ON CONFLICT(run_id, factory_id, pipeline_run_id, activity_run_id) DO UPDATE SET
      activity_name = excluded.activity_name,
      activity_type = excluded.activity_type,
      status = excluded.status,
      activity_start_utc = excluded.activity_start_utc,
      activity_end_utc = excluded.activity_end_utc,
      duration_ms = excluded.duration_ms,
      used_diu = excluded.used_diu,
      copy_duration_seconds = excluded.copy_duration_seconds,
      data_read_bytes = excluded.data_read_bytes,
      data_written_bytes = excluded.data_written_bytes,
      mapping_dataflow_vcore_minutes = excluded.mapping_dataflow_vcore_minutes,
      error_json = excluded.error_json
  `);

  database.transaction((rows) => {
    for (const row of rows) {
      statement.run({ runId, factoryId, ...row });
    }
  })(activityRuns);
}

export function upsertDailyMetric(runId, factoryId, metric) {
  database.prepare(`
    INSERT INTO daily_metrics (
      run_id, factory_id, metric_date, window_start_utc, window_end_utc,
      pipeline_run_count, activity_run_count, orchestration_activity_run_count,
      copy_run_count, mapping_dataflow_run_count, pipeline_execution_minutes,
      external_pipeline_execution_minutes, total_diu_hours, mapping_dataflow_vcore_minutes,
      copy_data_read_bytes, copy_data_written_bytes, estimated_fabric_cuh, status, updated_at_utc
    ) VALUES (
      @runId, @factoryId, @metricDate, @windowStartUtc, @windowEndUtc,
      @pipelineRunCount, @activityRunCount, @orchestrationActivityRunCount,
      @copyRunCount, @mappingDataflowRunCount, @pipelineExecutionMinutes,
      @externalPipelineExecutionMinutes, @totalDiuHours, @mappingDataflowVcoreMinutes,
      @copyDataReadBytes, @copyDataWrittenBytes, @estimatedFabricCuh, @status, @updatedAtUtc
    )
    ON CONFLICT(run_id, factory_id, metric_date) DO UPDATE SET
      pipeline_run_count = excluded.pipeline_run_count,
      activity_run_count = excluded.activity_run_count,
      orchestration_activity_run_count = excluded.orchestration_activity_run_count,
      copy_run_count = excluded.copy_run_count,
      mapping_dataflow_run_count = excluded.mapping_dataflow_run_count,
      pipeline_execution_minutes = excluded.pipeline_execution_minutes,
      external_pipeline_execution_minutes = excluded.external_pipeline_execution_minutes,
      total_diu_hours = excluded.total_diu_hours,
      mapping_dataflow_vcore_minutes = excluded.mapping_dataflow_vcore_minutes,
      copy_data_read_bytes = excluded.copy_data_read_bytes,
      copy_data_written_bytes = excluded.copy_data_written_bytes,
      estimated_fabric_cuh = excluded.estimated_fabric_cuh,
      status = excluded.status,
      updated_at_utc = excluded.updated_at_utc
  `).run({ runId, factoryId, ...metric });
}

export function recordScanError(runId, factoryId, metricDate, scope, message) {
  database.prepare(`
    INSERT INTO scan_errors (run_id, factory_id, metric_date, scope, message, occurred_at_utc)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(runId, factoryId ?? null, metricDate ?? null, scope, message, utcNow());
}

export function upsertCheckpoint(runId, factoryId, metricDate, status) {
  database.prepare(`
    INSERT INTO checkpoints (run_id, factory_id, metric_date, status, updated_at_utc)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(run_id, factory_id, metric_date) DO UPDATE SET
      status = excluded.status,
      updated_at_utc = excluded.updated_at_utc
  `).run(runId, factoryId, metricDate, status, utcNow());
}
