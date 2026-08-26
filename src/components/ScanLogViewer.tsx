import { useDeferredValue, useMemo, useRef, useState } from 'react';
import { fetchScanLog, getScanLogUrl } from '../services/runOrchestrator';

type LogLevel = 'all' | 'info' | 'warn' | 'error';
const MAX_VISIBLE_ENTRIES = 500;

interface ScanLogEntry {
  timestampUtc?: string;
  level?: string;
  runId?: string;
  event?: string;
  [key: string]: unknown;
}

interface ScanLogViewerProps {
  backendRunId: string | null;
  scanRunning: boolean;
}

function parseLog(text: string): { entries: ScanLogEntry[]; invalidLineCount: number } {
  const entries: ScanLogEntry[] = [];
  let invalidLineCount = 0;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        entries.push(value as ScanLogEntry);
      } else {
        invalidLineCount += 1;
      }
    } catch {
      invalidLineCount += 1;
    }
  }

  return { entries, invalidLineCount };
}

function formatTimestamp(value: string | undefined): string {
  if (!value) {
    return 'Unknown time';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function ScanLogViewer({ backendRunId, scanRunning }: ScanLogViewerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [entries, setEntries] = useState<ScanLogEntry[]>([]);
  const [sourceLabel, setSourceLabel] = useState('No trace loaded');
  const [invalidLineCount, setInvalidLineCount] = useState(0);
  const [levelFilter, setLevelFilter] = useState<LogLevel>('all');
  const [eventFilter, setEventFilter] = useState('all');
  const [textFilter, setTextFilter] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const deferredTextFilter = useDeferredValue(textFilter.trim().toLowerCase());

  const eventOptions = useMemo(
    () => Array.from(new Set(entries.map((entry) => String(entry.event ?? 'unknown')))).sort((a, b) => a.localeCompare(b)),
    [entries],
  );
  const filteredEntries = useMemo(
    () => entries.filter((entry) => {
      if (levelFilter !== 'all' && entry.level !== levelFilter) {
        return false;
      }
      if (eventFilter !== 'all' && entry.event !== eventFilter) {
        return false;
      }
      return !deferredTextFilter || JSON.stringify(entry).toLowerCase().includes(deferredTextFilter);
    }),
    [deferredTextFilter, entries, eventFilter, levelFilter],
  );
  const displayedEntries = filteredEntries.slice(-MAX_VISIBLE_ENTRIES);

  function loadText(text: string, label: string): void {
    const parsed = parseLog(text);
    setEntries(parsed.entries);
    setInvalidLineCount(parsed.invalidLineCount);
    setSourceLabel(label);
    setLoadError(null);
    setLevelFilter('all');
    setEventFilter('all');
    setTextFilter('');
  }

  async function loadCurrentRun(): Promise<void> {
    if (!backendRunId) {
      return;
    }

    setIsLoading(true);
    setLoadError(null);
    try {
      loadText(await fetchScanLog(backendRunId), backendRunId);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Trace log could not be loaded.');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleFileSelected(file: File | undefined): Promise<void> {
    if (!file) {
      return;
    }

    setIsLoading(true);
    setLoadError(null);
    try {
      loadText(await file.text(), file.name);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Trace file could not be read.');
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <section className="panel log-viewer">
      <div className="panel__header">
        <div>
          <h2>Scan trace viewer</h2>
          <p>{sourceLabel} · {filteredEntries.length} of {entries.length} entries</p>
        </div>
        <div className="log-viewer__actions">
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            accept=".jsonl,.ndjson,application/x-ndjson,application/json,text/plain"
            onChange={(event) => {
              void handleFileSelected(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
          <button className="button button--secondary" type="button" onClick={() => fileInputRef.current?.click()} disabled={isLoading}>
            Open trace file
          </button>
          <button className="button button--secondary" type="button" onClick={() => void loadCurrentRun()} disabled={!backendRunId || isLoading}>
            {isLoading ? 'Loading...' : scanRunning ? 'Refresh live trace' : 'Load current trace'}
          </button>
          {backendRunId && (
            <a className="button button--secondary" href={getScanLogUrl(backendRunId)} download>
              Download
            </a>
          )}
        </div>
      </div>

      <div className="log-viewer__filters">
        <label>
          <span>Level</span>
          <select value={levelFilter} onChange={(event) => setLevelFilter(event.target.value as LogLevel)}>
            <option value="all">All levels</option>
            <option value="info">Info</option>
            <option value="warn">Warning</option>
            <option value="error">Error</option>
          </select>
        </label>
        <label>
          <span>Event</span>
          <select value={eventFilter} onChange={(event) => setEventFilter(event.target.value)}>
            <option value="all">All events</option>
            {eventOptions.map((event) => <option key={event} value={event}>{event}</option>)}
          </select>
        </label>
        <label className="log-viewer__search">
          <span>Search trace</span>
          <input value={textFilter} onChange={(event) => setTextFilter(event.target.value)} placeholder="Factory, status, URL, error..." />
        </label>
        <button
          className="button button--quiet"
          type="button"
          onClick={() => { setLevelFilter('all'); setEventFilter('all'); setTextFilter(''); }}
          disabled={levelFilter === 'all' && eventFilter === 'all' && !textFilter}
        >
          Clear filters
        </button>
      </div>

      {loadError && <p className="log-viewer__error">{loadError}</p>}
      {invalidLineCount > 0 && <p className="log-viewer__warning">Skipped {invalidLineCount} malformed line{invalidLineCount === 1 ? '' : 's'}.</p>}
      {filteredEntries.length > MAX_VISIBLE_ENTRIES && (
        <p className="log-viewer__notice">Showing the newest {MAX_VISIBLE_ENTRIES} matching entries. Filters still search all {entries.length} entries.</p>
      )}

      <div className="log-viewer__entries">
        {entries.length === 0 ? (
          <p className="empty-state">Load the current scan trace or open a downloaded JSONL file.</p>
        ) : filteredEntries.length === 0 ? (
          <p className="empty-state">No entries match the current filters.</p>
        ) : (
          displayedEntries.map((entry, index) => (
            <details className={`log-entry log-entry--${entry.level ?? 'info'}`} key={`${entry.timestampUtc ?? 'entry'}-${index}`}>
              <summary>
                <time>{formatTimestamp(entry.timestampUtc)}</time>
                <span className={`pill pill--log-${entry.level ?? 'info'}`}>{entry.level ?? 'info'}</span>
                <strong>{entry.event ?? 'unknown event'}</strong>
                <span className="log-entry__context">{String(entry.factoryName ?? entry.metricDate ?? entry.requestId ?? '')}</span>
              </summary>
              <pre>{JSON.stringify(entry, null, 2)}</pre>
            </details>
          ))
        )}
      </div>
    </section>
  );
}