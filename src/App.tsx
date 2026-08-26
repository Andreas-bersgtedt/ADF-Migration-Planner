import { useEffect, useState } from 'react';
import { useMsal } from '@azure/msal-react';
import { getBackendIdentity, type BackendIdentity } from './api/azureManagement';
import { isBackendAuth, isClientSecretAuth, isMsalConfigured, loginRequest, msalConfigurationError } from './auth/msalConfig';
import { StatusCard } from './components/StatusCard';
import { ScanLogViewer } from './components/ScanLogViewer';
import { db } from './data/db';
import { usePlannerData } from './hooks/usePlannerData';
import { getScanLogUrl, scanSelectedFactories, startInventoryRun } from './services/runOrchestrator';
import { exportUsageSummaryToExcel } from './utils/exportExcel';

const scanProfileOptions = [
  { days: 1, label: 'Today - 1 day' },
  { days: 3, label: 'Today - 3 days' },
  { days: 5, label: 'Today - 5 days' },
  { days: 7, label: 'Today - 7 days' },
];

const defaultAdaptiveScanSettings = {
  enabled: true,
  min: 1,
  start: 3,
  max: 8,
  stableWindow: 3,
};

const fabricSkuCapacities = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];

function App() {
  const { instance, accounts } = useMsal();
  const { subscriptions, factories, factoryUsage, runs, runSteps, progress } = usePlannerData();
  const [message, setMessage] = useState<string>('Ready to connect to a tenant and start subscription-by-subscription inventory.');
  const [isRunning, setIsRunning] = useState(false);
  const [selectedFactoryIds, setSelectedFactoryIds] = useState<string[]>([]);
  const [scanTargetFactoryIds, setScanTargetFactoryIds] = useState<string[]>([]);
  const [scanTargetFactoryCount, setScanTargetFactoryCount] = useState(0);
  const [scanTargetSubscriptionIds, setScanTargetSubscriptionIds] = useState<string[]>([]);
  const [scanProfileDays, setScanProfileDays] = useState<number>(7);
  const [factoryConcurrency, setFactoryConcurrency] = useState(2);
  const [adaptiveScanSettings, setAdaptiveScanSettings] = useState(defaultAdaptiveScanSettings);
  const [traceLogEnabled, setTraceLogEnabled] = useState(true);
  const [traceVerboseEnabled, setTraceVerboseEnabled] = useState(false);
  const [scanLogRunId, setScanLogRunId] = useState<string | null>(null);
  const [hideScannedFactories, setHideScannedFactories] = useState(false);
  const [subscriptionFilter, setSubscriptionFilter] = useState<string>('all');
  const [factoryTextFilter, setFactoryTextFilter] = useState('');
  const [debugModeEnabled, setDebugModeEnabled] = useState(false);
  const [backendIdentity, setBackendIdentity] = useState<BackendIdentity | null>(null);

  const activeAccount = instance.getActiveAccount() ?? accounts[0] ?? null;
  const isAuthenticated = isBackendAuth ? backendIdentity !== null : activeAccount !== null;
  const activeTenantId = backendIdentity?.tenantId ?? activeAccount?.tenantId ?? 'organizations';
  const activeUsername = backendIdentity?.username ?? activeAccount?.username ?? 'Not signed in';
  const latestRun = runs[0];
  const latestRunProgress = latestRun ? progress.filter((item) => item.runId === latestRun.runId) : [];
  const latestRunSteps = latestRun ? runSteps.filter((item) => item.runId === latestRun.runId).slice(0, 20) : [];
  const latestRunUsage = latestRun ? factoryUsage.filter((item) => item.runId === latestRun.runId) : [];
  const scanTargetFactorySet = new Set(scanTargetFactoryIds);
  const scannedFactoryIds = new Set(latestRunUsage.map((item) => item.factoryId));
  const subscriptionFilterOptions = Array.from(new Set(factories.map((factory) => factory.subscriptionId))).sort((a, b) =>
    a.localeCompare(b),
  );
  const normalizedTextFilter = factoryTextFilter.trim().toLowerCase();
  const visibleFactories = factories.filter((factory) => {
    if (hideScannedFactories && scannedFactoryIds.has(factory.id)) {
      return false;
    }

    if (subscriptionFilter !== 'all' && factory.subscriptionId !== subscriptionFilter) {
      return false;
    }

    if (!normalizedTextFilter) {
      return true;
    }

    const searchable = `${factory.name} ${factory.resourceGroup} ${factory.location} ${factory.subscriptionId}`.toLowerCase();
    return searchable.includes(normalizedTextFilter);
  });
  const selectedFactoryCount = selectedFactoryIds.length;
  const inventoryTotalSubscriptions = latestRunProgress.length;
  const inventoryCompletedSubscriptions = latestRunProgress.filter(
    (item) => item.status !== 'inventory-running' && item.status !== 'not-started',
  ).length;
  const inventoryProgressPercent =
    inventoryTotalSubscriptions > 0
      ? Math.round((inventoryCompletedSubscriptions / inventoryTotalSubscriptions) * 100)
      : 0;
  const completedUsageFactoryCount = latestRunUsage.filter(
    (item) =>
      (scanTargetFactorySet.size === 0 || scanTargetFactorySet.has(item.factoryId)) &&
      (item.status === 'collected' || item.status === 'failed'),
  ).length;
  const usageProgressPercent =
    scanTargetFactoryCount > 0 ? Math.round((completedUsageFactoryCount / scanTargetFactoryCount) * 100) : 0;
  const usageScannedDayChunks = latestRunUsage.reduce((total, row) => total + asNumber(row.scannedDayChunks), 0);
  const usageTotalDayChunks = latestRunUsage.reduce((total, row) => total + asNumber(row.totalDayChunks), 0);
  const usageChunkProgressPercent =
    usageTotalDayChunks > 0 ? Math.round((usageScannedDayChunks / usageTotalDayChunks) * 100) : 0;
  const usageTargetSubscriptionCount = scanTargetSubscriptionIds.length;
  const usageCompletedSubscriptionCount = latestRunProgress.filter(
    (item) =>
      scanTargetSubscriptionIds.includes(item.subscriptionId) &&
      (item.status === 'usage-complete' || item.status === 'failed'),
  ).length;
  const usageSubscriptionProgressPercent =
    usageTargetSubscriptionCount > 0
      ? Math.round((usageCompletedSubscriptionCount / usageTargetSubscriptionCount) * 100)
      : 0;
  const aggregateDailyCuh = new Map<string, number>();
  let hasIncompleteDailyMetrics = false;
  for (const usage of latestRunUsage) {
    for (const dailyMetric of usage.dailyMetrics ?? []) {
      aggregateDailyCuh.set(
        dailyMetric.metricDate,
        (aggregateDailyCuh.get(dailyMetric.metricDate) ?? 0) + asNumber(dailyMetric.estimatedFabricCuh),
      );
      hasIncompleteDailyMetrics ||= dailyMetric.status !== 'completed';
    }
  }
  const peakDailyAggregate = Array.from(aggregateDailyCuh.entries()).reduce<{ metricDate: string; estimatedFabricCuh: number } | null>(
    (peak, [metricDate, estimatedFabricCuh]) =>
      !peak || estimatedFabricCuh > peak.estimatedFabricCuh ? { metricDate, estimatedFabricCuh } : peak,
    null,
  );
  const aggregatePeakCuRequired = peakDailyAggregate ? peakDailyAggregate.estimatedFabricCuh / 24 : 0;
  const minimumFabricSkuCapacity = fabricSkuCapacities.find((capacity) => capacity >= aggregatePeakCuRequired);
  const minimumFabricSku = peakDailyAggregate
    ? minimumFabricSkuCapacity
      ? `F${minimumFabricSkuCapacity}`
      : '> F2048'
    : 'Rescan required';
  const capacityCardDetail = peakDailyAggregate
    ? `${aggregatePeakCuRequired.toFixed(2)} average CU on ${peakDailyAggregate.metricDate} (${peakDailyAggregate.estimatedFabricCuh.toFixed(2)} CUh)${hasIncompleteDailyMetrics ? ' · partial data' : ''}`
    : 'Daily metrics are unavailable for legacy scan results';

  useEffect(() => {
    if (activeAccount) {
      setMessage(`Signed in as ${activeAccount.username}.`);
    }
  }, [activeAccount]);

  useEffect(() => {
    if (isBackendAuth) {
      void refreshBackendIdentity();
    }
  }, []);

  useEffect(() => {
    setSelectedFactoryIds((existing) => existing.filter((id) => factories.some((factory) => factory.id === id)));
  }, [factories]);

  async function handleSignIn(): Promise<void> {
    if (!isMsalConfigured) {
      setMessage(msalConfigurationError ?? 'MSAL is not configured.');
      return;
    }

    if (isBackendAuth) {
      await refreshBackendIdentity();
    } else {
      setMessage('Redirecting to Microsoft Entra sign-in...');
      await instance.loginRedirect(loginRequest);
    }
  }

  async function refreshBackendIdentity(): Promise<void> {
    setMessage(`Checking ${isClientSecretAuth ? 'service principal credentials' : 'the local Azure CLI session'}...`);
    try {
      const identity = await getBackendIdentity();
      setBackendIdentity(identity);
      setMessage(`Using ${identity.authMode === 'client-secret' ? 'service principal' : 'Azure CLI account'} ${identity.username}.`);
    } catch (error) {
      setBackendIdentity(null);
      setMessage(
        error instanceof Error
          ? `${error.message}${isClientSecretAuth ? '' : ' Run az login --tenant <tenant-id> in a terminal, then retry.'}`
          : 'Backend authentication failed.',
      );
    }
  }

  async function handleStartRun(): Promise<void> {
    if (!isMsalConfigured) {
      setMessage(msalConfigurationError ?? 'MSAL is not configured.');
      return;
    }

    setIsRunning(true);
    setScanLogRunId(null);
    setMessage('Inventory discovery started. Subscriptions and factories will be loaded, then you can select factories for usage scanning.');

    try {
      const run = await startInventoryRun(instance, activeTenantId);
      setSelectedFactoryIds([]);
      setScanTargetFactoryIds([]);
      setScanTargetFactoryCount(0);
      setScanTargetSubscriptionIds([]);
      if (run.status === 'failed') {
        setMessage(`Inventory completed with failures for run ${run.runId}. Review subscription status and continue with available factories.`);
      } else {
        setMessage(`Inventory completed for run ${run.runId}. Select factories and start usage scan.`);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Inventory run failed.');
    } finally {
      setIsRunning(false);
    }
  }

  async function handleScanSelected(): Promise<void> {
    if (!latestRun) {
      setMessage('Start inventory first to create a run context.');
      return;
    }

    if (selectedFactoryIds.length === 0) {
      setMessage('Select at least one factory before starting the usage scan.');
      return;
    }

    const selectedFactories = factories.filter((factory) => selectedFactoryIds.includes(factory.id));
    const subscriptionIds = Array.from(new Set(selectedFactories.map((factory) => factory.subscriptionId)));
    setScanTargetFactoryIds(selectedFactoryIds);
    setScanTargetFactoryCount(selectedFactoryIds.length);
    setScanTargetSubscriptionIds(subscriptionIds);
    setScanLogRunId(null);

    setIsRunning(true);
    setMessage(`Scanning ${selectedFactoryIds.length} selected factories for activity runs and execution hours over the last ${scanProfileDays} days...`);

    try {
      const run = await scanSelectedFactories(
        instance,
        latestRun.runId,
        selectedFactoryIds,
        scanProfileDays,
        adaptiveScanSettings,
        factoryConcurrency,
        traceLogEnabled,
        traceVerboseEnabled,
        setScanLogRunId,
      );
      if (run.status === 'failed') {
        setMessage(`Usage scan finished with failures for run ${run.runId}. Check subscription status and usage rows.`);
      } else {
        setMessage(`Usage scan completed for run ${run.runId}.`);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Usage scan failed.');
    } finally {
      setIsRunning(false);
    }
  }

  function toggleFactorySelection(factoryId: string): void {
    setSelectedFactoryIds((existing) =>
      existing.includes(factoryId) ? existing.filter((id) => id !== factoryId) : [...existing, factoryId],
    );
  }

  function updateAdaptiveSetting<K extends keyof typeof defaultAdaptiveScanSettings>(key: K, value: number | boolean): void {
    setAdaptiveScanSettings((current) => ({
      ...current,
      [key]: value,
    }));
  }

  function selectAllFactories(): void {
    setSelectedFactoryIds(visibleFactories.map((factory) => factory.id));
  }

  function clearSelection(): void {
    setSelectedFactoryIds([]);
  }

  function asNumber(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  async function handleExportUsageSummary(): Promise<void> {
    if (!latestRun || latestRunUsage.length === 0) {
      setMessage('No usage rows are available to export yet.');
      return;
    }

    try {
      await exportUsageSummaryToExcel(latestRun.runId, latestRunUsage);
      setMessage(`Exported ${latestRunUsage.length} usage rows to Excel for run ${latestRun.runId}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to export usage summary.');
    }
  }

  async function handleClearResults(): Promise<void> {
    try {
      await db.factoryUsage.clear();
      setSelectedFactoryIds([]);
      setScanTargetFactoryIds([]);
      setScanTargetFactoryCount(0);
      setScanTargetSubscriptionIds([]);
      setMessage('Cleared all saved usage results.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to clear saved usage results.');
    }
  }

  return (
    <div className="app-shell">
      <header className="hero">
        <p className="eyebrow">ADF Migration Planner</p>
        <div className="hero__panel">
          <p className="hero__meta">Tenant</p>
          <strong>{activeTenantId}</strong>
          <p className="hero__meta">User</p>
          <strong>{activeUsername}</strong>
          <div className="hero__actions">
            <button className="button button--secondary" type="button" onClick={handleSignIn} disabled={!isMsalConfigured}>
              {isClientSecretAuth ? 'Verify service principal' : isBackendAuth ? 'Refresh CLI session' : activeAccount ? 'Switch account' : 'Sign in'}
            </button>
            <button className="button" type="button" onClick={handleStartRun} disabled={!isAuthenticated || isRunning || !isMsalConfigured}>
              {isRunning ? 'Running...' : 'Start inventory run'}
            </button>
          </div>
          {!isMsalConfigured ? <p className="hero__warning">{msalConfigurationError}</p> : null}
        </div>
      </header>

      <main className="content-grid">
        <section className="summary-grid">
          <StatusCard label="Subscriptions" value={subscriptions.length} detail="Visible to the signed-in user" />
          <StatusCard label="Factories" value={factories.length} detail="Persisted in local IndexedDB state" />
          <StatusCard label="Selected" value={selectedFactoryCount} detail="Factories queued for usage scan" />
          <StatusCard
            label="Latest Run"
            value={latestRun?.status ?? 'No runs'}
            detail={latestRun?.currentStep ?? 'Waiting for first execution'}
          />
        </section>

        <section className="panel">
          <div className="panel__header">
            <h2>Execution status</h2>
            <p>{message}</p>
            <label className="filter-toolbar__checkbox">
              <input
                type="checkbox"
                checked={debugModeEnabled}
                onChange={(event) => setDebugModeEnabled(event.target.checked)}
              />
              Debug mode
            </label>
          </div>
          <div className="progress-grid">
            <div className="progress-card">
              <div className="progress-card__label-row">
                <strong>Inventory progress</strong>
                <span>{inventoryCompletedSubscriptions}/{inventoryTotalSubscriptions || 0} subscriptions</span>
              </div>
              <div className="progress-track" aria-label="Inventory progress">
                <div className="progress-track__fill" style={{ width: `${inventoryProgressPercent}%` }} />
              </div>
            </div>
            <div className="progress-card">
              <div className="progress-card__label-row">
                <strong>Usage scan progress</strong>
                <span>{completedUsageFactoryCount}/{scanTargetFactoryCount || 0} factories</span>
              </div>
              <div className="progress-track" aria-label="Usage scan progress">
                <div className="progress-track__fill progress-track__fill--usage" style={{ width: `${usageProgressPercent}%` }} />
              </div>
              <p className="progress-card__meta">
                Subscription progress: {usageCompletedSubscriptionCount}/{usageTargetSubscriptionCount || 0} ({usageSubscriptionProgressPercent}%)
              </p>
            </div>
            <div className="progress-card">
              <div className="progress-card__label-row">
                <strong>Day-chunk progress</strong>
                <span>{usageScannedDayChunks}/{usageTotalDayChunks || 0} chunks</span>
              </div>
              <div className="progress-track" aria-label="Day chunk progress">
                <div className="progress-track__fill progress-track__fill--chunks" style={{ width: `${usageChunkProgressPercent}%` }} />
              </div>
              <p className="progress-card__meta">
                Usage data is scanned in daily windows for better reliability and recoverability ({scanProfileDays} day profile).
              </p>
            </div>
          </div>
          <div className="run-list">
            {latestRunProgress.length === 0 ? (
              <p className="empty-state">No subscription checkpoints yet.</p>
            ) : (
              latestRunProgress.map((item) => (
                <article key={item.id} className="run-row">
                  <div>
                    <strong>{item.subscriptionName ?? item.subscriptionId}</strong>
                    <p className="run-row__meta">{item.subscriptionId}</p>
                    <p>{item.lastStep ?? 'pending'}</p>
                  </div>
                  <span className={`pill pill--${item.status}`}>{item.status}</span>
                </article>
              ))
            )}
          </div>
        </section>

        {debugModeEnabled ? (
          <section className="panel">
            <div className="panel__header">
              <h2>Debug trace</h2>
              <p>Latest run step events (newest first). Use this to pinpoint where inventory or scan is blocking.</p>
            </div>
            <div className="run-list">
              {latestRunSteps.length === 0 ? (
                <p className="empty-state">No run step events yet.</p>
              ) : (
                latestRunSteps.map((step) => (
                  <article key={step.stepId} className="run-row">
                    <div>
                      <strong>{step.stepName}</strong>
                      <p className="run-row__meta">{step.subscriptionId ?? 'all subscriptions'} • {step.startedAtUtc}</p>
                      <p>{step.message ?? 'No message provided.'}</p>
                    </div>
                    <span className={`pill pill--${step.status}`}>{step.status}</span>
                  </article>
                ))
              )}
            </div>
          </section>
        ) : null}

        <ScanLogViewer backendRunId={scanLogRunId} scanRunning={isRunning} />

        <section className="panel">
          <div className="panel__header">
            <h2>Usage summary</h2>
            <p>Run-scoped usage across selected factories for the chosen scan profile, including Fabric CU-hour estimate based on DIU, orchestration runs, and mapping dataflow vCore usage.</p>
          </div>
          <div className="usage-capacity-summary">
            <StatusCard label="Minimum viable SKU" value={minimumFabricSku} detail={capacityCardDetail} />
          </div>
          <div className="usage-actions">
            <button className="button button--secondary" type="button" onClick={handleExportUsageSummary} disabled={latestRunUsage.length === 0 || isRunning}>
              Export to Excel
            </button>
            <button className="button button--secondary" type="button" onClick={handleClearResults} disabled={latestRunUsage.length === 0 || isRunning}>
              Clear results
            </button>
          </div>
          <div className="table-wrap">
            <table className="usage-summary-table">
              <thead>
                <tr>
                  <th>Factory</th>
                  <th>Subscription</th>
                  <th>Status</th>
                  <th>Activity runs</th>
                  <th>Orchestration runs</th>
                  <th>Mapping dataflow runs</th>
                  <th>Mapping dataflow vCore minutes</th>
                  <th>Pipeline runs</th>
                  <th>Pipeline minutes</th>
                  <th>External pipeline minutes</th>
                  <th>Copy runs</th>
                  <th>Copy data moved (GiB)</th>
                  <th>Window DIU-hours</th>
                  <th>Est. Fabric CUh (DIU)</th>
                  <th>Est. Fabric CUh (Orch)</th>
                  <th>Est. Fabric CUh (MDF)</th>
                  <th>Est. Fabric CUh (Total)</th>
                  <th>Max Daily CUh</th>
                  <th>Peak Daily CU Required</th>
                </tr>
              </thead>
              <tbody>
                {latestRunUsage.length === 0 ? (
                  <tr>
                    <td colSpan={19} className="empty-state">Run inventory, select factories, and start usage scan to generate usage summary rows.</td>
                  </tr>
                ) : (
                  latestRunUsage.map((usage) => (
                    <tr key={usage.id}>
                      <td>{usage.factoryName}</td>
                      <td>{usage.subscriptionId}</td>
                      <td><span className={`pill pill--${usage.status}`}>{usage.status}</span></td>
                      <td>{asNumber(usage.activityRunCount)}</td>
                      <td>{asNumber(usage.orchestrationActivityRunCount)}</td>
                      <td>{asNumber(usage.mappingDataflowRunCount)}</td>
                      <td>{asNumber(usage.mappingDataflowVcoreMinutes).toFixed(2)}</td>
                      <td>{asNumber(usage.pipelineRunCount)}</td>
                      <td>{asNumber(usage.pipelineExecutionMinutes).toFixed(2)}</td>
                      <td>{asNumber(usage.externalPipelineExecutionMinutes).toFixed(2)}</td>
                      <td>{asNumber(usage.copyRunCount)}</td>
                      <td>{asNumber(usage.copyDataMovedGiB).toFixed(3)}</td>
                      <td>{asNumber(usage.totalDiuHours).toFixed(2)}</td>
                      <td>{asNumber(usage.estimatedFabricCuhFromDiu).toFixed(3)}</td>
                      <td>{asNumber(usage.estimatedFabricCuhFromOrchestration).toFixed(3)}</td>
                      <td>{asNumber(usage.estimatedFabricCuhFromMappingDataflow).toFixed(3)}</td>
                      <td>{asNumber(usage.estimatedFabricCuhTotal).toFixed(3)}</td>
                      <td>{asNumber(usage.maxDailyEstimatedFabricCuh).toFixed(3)}</td>
                      <td>{asNumber(usage.peakDailyCuRequired).toFixed(3)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel">
          <div className="panel__header">
            <h2>Factory inventory</h2>
            <p>Inventory gate: select only the factories that should be scanned for run metrics.</p>
          </div>
          <div className="filter-toolbar">
            <label className="filter-toolbar__group">
              <span>Filter subscription</span>
              <select value={subscriptionFilter} onChange={(event) => setSubscriptionFilter(event.target.value)} disabled={isRunning}>
                <option value="all">All subscriptions</option>
                {subscriptionFilterOptions.map((subscriptionId) => (
                  <option key={subscriptionId} value={subscriptionId}>{subscriptionId}</option>
                ))}
              </select>
            </label>
            <label className="filter-toolbar__group">
              <span>Search</span>
              <input
                type="text"
                value={factoryTextFilter}
                onChange={(event) => setFactoryTextFilter(event.target.value)}
                placeholder="Filter by factory, RG, location..."
                disabled={isRunning}
              />
            </label>
            <label className="filter-toolbar__checkbox">
              <input
                type="checkbox"
                checked={hideScannedFactories}
                onChange={(event) => setHideScannedFactories(event.target.checked)}
                disabled={isRunning}
              />
              Hide scanned factories
            </label>
          </div>
          <div className="selection-toolbar">
            <span>{selectedFactoryCount} selected • {visibleFactories.length} visible</span>
            <div className="selection-toolbar__actions">
              <label className="selection-toolbar__profile">
                <span>Scan profile</span>
                <select value={scanProfileDays} onChange={(event) => setScanProfileDays(Number(event.target.value))} disabled={isRunning}>
                  {scanProfileOptions.map((option) => (
                    <option key={option.days} value={option.days}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className="selection-toolbar__profile tooltip" data-tooltip="Let the backend increase concurrency after stable requests and reduce it when Azure throttles.">
                <span>Adaptive scan</span>
                <input
                  type="checkbox"
                  checked={adaptiveScanSettings.enabled}
                  onChange={(event) => updateAdaptiveSetting('enabled', event.target.checked)}
                  disabled={isRunning}
                  aria-label="Enable adaptive scan tuning"
                  title="Let the backend tune concurrency automatically using successful requests and Azure throttling signals."
                />
              </label>
              <label className="selection-toolbar__profile selection-toolbar__profile--compact tooltip" data-tooltip="Factories scanned at the same time. Each factory has an independent adaptive controller. Maximum 10.">
                <span>Factory concurrency</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={factoryConcurrency}
                  onChange={(event) => setFactoryConcurrency(Math.min(10, Math.max(1, Number(event.target.value) || 1)))}
                  disabled={isRunning}
                  aria-label="Factory scan concurrency"
                  title="Number of factories scanned concurrently, from 1 to 10."
                />
              </label>
              <label className="selection-toolbar__profile tooltip" data-tooltip="Write a detailed, unique trace file for this scan batch, including runtime settings, requests, retries, and failures.">
                <span>Trace log</span>
                <input
                  type="checkbox"
                  checked={traceLogEnabled}
                  onChange={(event) => setTraceLogEnabled(event.target.checked)}
                  disabled={isRunning}
                  aria-label="Enable scan trace log"
                  title="Create a detailed trace log for this scan batch."
                />
              </label>
              <label className="selection-toolbar__profile tooltip" data-tooltip="Also record every successful ARM request start and completion. This can make trace files much larger.">
                <span>Verbose trace</span>
                <input
                  type="checkbox"
                  checked={traceVerboseEnabled}
                  onChange={(event) => setTraceVerboseEnabled(event.target.checked)}
                  disabled={isRunning || !traceLogEnabled}
                  aria-label="Enable verbose ARM request tracing"
                  title="Include successful ARM request start and completion events."
                />
              </label>
              <div className="selection-toolbar__profile selection-toolbar__profile--compact tooltip" data-tooltip="Min is the safety floor, Start is the initial concurrency, and Max is the adaptive ceiling.">
                <span>Min / Start / Max</span>
                <div className="inline-numeric-controls">
                  <input
                    type="number"
                    min={1}
                    max={adaptiveScanSettings.max}
                    value={adaptiveScanSettings.min}
                    onChange={(event) => updateAdaptiveSetting('min', Math.max(1, Number(event.target.value) || 1))}
                    disabled={isRunning || !adaptiveScanSettings.enabled}
                    aria-label="Minimum adaptive concurrency"
                    title="Minimum concurrency: the lowest parallel request limit after throttling."
                  />
                  <input
                    type="number"
                    min={adaptiveScanSettings.min}
                    max={adaptiveScanSettings.max}
                    value={adaptiveScanSettings.start}
                    onChange={(event) => updateAdaptiveSetting('start', Math.max(adaptiveScanSettings.min, Number(event.target.value) || adaptiveScanSettings.min))}
                    disabled={isRunning || !adaptiveScanSettings.enabled}
                    aria-label="Starting adaptive concurrency"
                    title="Starting concurrency: the parallel request limit used when the scan begins."
                  />
                  <input
                    type="number"
                    min={adaptiveScanSettings.start}
                    value={adaptiveScanSettings.max}
                    onChange={(event) => updateAdaptiveSetting('max', Math.max(adaptiveScanSettings.start, Number(event.target.value) || adaptiveScanSettings.start))}
                    disabled={isRunning || !adaptiveScanSettings.enabled}
                    aria-label="Maximum adaptive concurrency"
                    title="Maximum concurrency: the adaptive ceiling for parallel requests."
                  />
                </div>
              </div>
              <label className="selection-toolbar__profile selection-toolbar__profile--compact tooltip" data-tooltip="Number of successful requests needed before adaptive concurrency increases by one.">
                <span>Stable window</span>
                <input
                  type="number"
                  min={1}
                  value={adaptiveScanSettings.stableWindow}
                  onChange={(event) => updateAdaptiveSetting('stableWindow', Math.max(1, Number(event.target.value) || 1))}
                  disabled={isRunning || !adaptiveScanSettings.enabled}
                  aria-label="Adaptive stable success window"
                  title="Stable window: successful requests required before concurrency ramps up."
                />
              </label>
              <button className="button button--secondary" type="button" onClick={selectAllFactories} disabled={visibleFactories.length === 0 || isRunning}>
                Select all
              </button>
              <button className="button button--secondary" type="button" onClick={clearSelection} disabled={selectedFactoryCount === 0 || isRunning}>
                Clear
              </button>
              <button className="button" type="button" onClick={handleScanSelected} disabled={!activeAccount || isRunning || selectedFactoryCount === 0}>
                {isRunning ? 'Scanning...' : 'Scan selected factories'}
              </button>
              {scanLogRunId && (
                <a className="button button--secondary" href={getScanLogUrl(scanLogRunId)} download>
                  Download trace log
                </a>
              )}
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Select</th>
                  <th>Name</th>
                  <th>Subscription</th>
                  <th>Resource Group</th>
                  <th>Location</th>
                </tr>
              </thead>
              <tbody>
                {visibleFactories.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="empty-state">{factories.length === 0 ? 'Run inventory to load factories.' : 'No factories match the current filters.'}</td>
                  </tr>
                ) : (
                  visibleFactories.map((factory) => (
                    <tr key={factory.id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedFactoryIds.includes(factory.id)}
                          onChange={() => toggleFactorySelection(factory.id)}
                          disabled={isRunning}
                          aria-label={`Select ${factory.name}`}
                        />
                      </td>
                      <td>{factory.name}</td>
                      <td>{factory.subscriptionId}</td>
                      <td>{factory.resourceGroup}</td>
                      <td>{factory.location}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
