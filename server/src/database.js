import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(moduleDirectory, '..', '..');
const defaultDatabasePath = resolve(moduleDirectory, '..', 'data', 'adf-migration-planner.sqlite');
const configuredDatabasePath = process.env.SCAN_DATABASE_PATH?.trim();
export const databasePath = configuredDatabasePath
  ? resolve(repositoryRoot, configuredDatabasePath)
  : defaultDatabasePath;

mkdirSync(dirname(databasePath), { recursive: true });

export const database = new Database(databasePath);
database.pragma('journal_mode = WAL');
database.pragma('foreign_keys = ON');
database.pragma('busy_timeout = 5000');

database.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    created_at_utc TEXT NOT NULL,
    status TEXT NOT NULL,
    payload_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS factories (
    run_id TEXT NOT NULL,
    factory_id TEXT NOT NULL,
    subscription_id TEXT NOT NULL,
    resource_group TEXT NOT NULL,
    factory_name TEXT NOT NULL,
    location TEXT NOT NULL,
    PRIMARY KEY (run_id, factory_id),
    FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS factory_usage (
    run_id TEXT NOT NULL,
    factory_id TEXT NOT NULL,
    subscription_id TEXT NOT NULL,
    status TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (run_id, factory_id),
    FOREIGN KEY (run_id, factory_id) REFERENCES factories(run_id, factory_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS daily_metrics (
    run_id TEXT NOT NULL,
    factory_id TEXT NOT NULL,
    metric_date TEXT NOT NULL,
    window_start_utc TEXT NOT NULL,
    window_end_utc TEXT NOT NULL,
    pipeline_run_count INTEGER NOT NULL DEFAULT 0,
    activity_run_count INTEGER NOT NULL DEFAULT 0,
    orchestration_activity_run_count INTEGER NOT NULL DEFAULT 0,
    copy_run_count INTEGER NOT NULL DEFAULT 0,
    mapping_dataflow_run_count INTEGER NOT NULL DEFAULT 0,
    pipeline_execution_minutes REAL NOT NULL DEFAULT 0,
    external_pipeline_execution_minutes REAL NOT NULL DEFAULT 0,
    total_diu_hours REAL NOT NULL DEFAULT 0,
    mapping_dataflow_vcore_minutes REAL NOT NULL DEFAULT 0,
    copy_data_read_bytes REAL NOT NULL DEFAULT 0,
    copy_data_written_bytes REAL NOT NULL DEFAULT 0,
    estimated_fabric_cuh REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL,
    PRIMARY KEY (run_id, factory_id, metric_date),
    FOREIGN KEY (run_id, factory_id) REFERENCES factories(run_id, factory_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS pipeline_runs (
    run_id TEXT NOT NULL,
    factory_id TEXT NOT NULL,
    pipeline_run_id TEXT NOT NULL,
    pipeline_name TEXT,
    invoked_by_name TEXT,
    status TEXT,
    run_start_utc TEXT,
    run_end_utc TEXT,
    duration_minutes REAL NOT NULL DEFAULT 0,
    parameters_json TEXT,
    PRIMARY KEY (run_id, factory_id, pipeline_run_id),
    FOREIGN KEY (run_id, factory_id) REFERENCES factories(run_id, factory_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS activity_runs (
    run_id TEXT NOT NULL,
    factory_id TEXT NOT NULL,
    pipeline_run_id TEXT NOT NULL,
    activity_run_id TEXT NOT NULL,
    activity_name TEXT,
    activity_type TEXT,
    status TEXT,
    activity_start_utc TEXT,
    activity_end_utc TEXT,
    duration_ms REAL NOT NULL DEFAULT 0,
    used_diu REAL NOT NULL DEFAULT 0,
    copy_duration_seconds REAL NOT NULL DEFAULT 0,
    data_read_bytes REAL NOT NULL DEFAULT 0,
    data_written_bytes REAL NOT NULL DEFAULT 0,
    mapping_dataflow_vcore_minutes REAL NOT NULL DEFAULT 0,
    error_json TEXT,
    PRIMARY KEY (run_id, factory_id, pipeline_run_id, activity_run_id),
    FOREIGN KEY (run_id, factory_id, pipeline_run_id)
      REFERENCES pipeline_runs(run_id, factory_id, pipeline_run_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS scan_errors (
    error_id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    factory_id TEXT,
    metric_date TEXT,
    scope TEXT NOT NULL,
    message TEXT NOT NULL,
    occurred_at_utc TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS checkpoints (
    run_id TEXT NOT NULL,
    factory_id TEXT NOT NULL,
    metric_date TEXT NOT NULL,
    status TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL,
    PRIMARY KEY (run_id, factory_id, metric_date),
    FOREIGN KEY (run_id, factory_id) REFERENCES factories(run_id, factory_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at_utc DESC);
  CREATE INDEX IF NOT EXISTS idx_pipeline_runs_start ON pipeline_runs(run_start_utc);
  CREATE INDEX IF NOT EXISTS idx_activity_runs_start ON activity_runs(activity_start_utc);
  CREATE INDEX IF NOT EXISTS idx_scan_errors_run ON scan_errors(run_id, occurred_at_utc);
`);