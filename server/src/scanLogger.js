import { appendFile, mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const configuredLogDirectory = process.env.SCAN_LOG_DIRECTORY?.trim();
const logDirectory = configuredLogDirectory
  ? path.resolve(configuredLogDirectory)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'logs');

function getLogPath(runId) {
  if (!/^run-[a-zA-Z0-9-]+$/.test(runId)) {
    throw new Error('Invalid scan run ID.');
  }

  return path.join(logDirectory, `${runId}.jsonl`);
}

function sanitize(value, key = '') {
  if (/token|secret|authorization/i.test(key)) {
    return '[REDACTED]';
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, sanitize(childValue, childKey)]));
  }

  return value;
}

export async function createScanLogger(runId) {
  await mkdir(logDirectory, { recursive: true });
  const filePath = getLogPath(runId);
  const file = await open(filePath, 'wx');
  await file.close();

  let pendingWrite = Promise.resolve();
  const write = (level, event, details = {}) => {
    const entry = JSON.stringify({
      timestampUtc: new Date().toISOString(),
      level,
      runId,
      event,
      ...sanitize(details),
    });
    pendingWrite = pendingWrite
      .then(() => appendFile(filePath, `${entry}\n`, 'utf8'))
      .catch((error) => {
        console.error(`[run:${runId}] Trace log write failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    return pendingWrite;
  };

  return {
    filePath,
    info: (event, details) => write('info', event, details),
    warn: (event, details) => write('warn', event, details),
    error: (event, details) => write('error', event, details),
    flush: () => pendingWrite,
  };
}

export async function readScanLog(runId) {
  return readFile(getLogPath(runId));
}

export function getScanLogFileName(runId) {
  getLogPath(runId);
  return `${runId}.jsonl`;
}