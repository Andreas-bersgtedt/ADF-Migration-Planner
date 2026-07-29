import type { FactoryUsageRecord } from '../types/azure';

type ColumnType = StringConstructor | NumberConstructor;

interface ExportColumn {
  header: string;
  type: ColumnType;
  value: (row: FactoryUsageRecord) => string | number;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

const exportColumns: ExportColumn[] = [
  { header: 'Factory', type: String, value: (row) => row.factoryName },
  { header: 'Subscription', type: String, value: (row) => row.subscriptionId },
  { header: 'Status', type: String, value: (row) => row.status },
  { header: 'Total day chunks', type: Number, value: (row) => asNumber(row.totalDayChunks) },
  { header: 'Scanned day chunks', type: Number, value: (row) => asNumber(row.scannedDayChunks) },
  { header: 'Failed day chunks', type: Number, value: (row) => asNumber(row.failedDayChunks) },
  { header: 'Activity runs', type: Number, value: (row) => asNumber(row.activityRunCount) },
  { header: 'Orchestration runs', type: Number, value: (row) => asNumber(row.orchestrationActivityRunCount) },
  { header: 'Mapping dataflow runs', type: Number, value: (row) => asNumber(row.mappingDataflowRunCount) },
  { header: 'Mapping dataflow vCore minutes', type: Number, value: (row) => asNumber(row.mappingDataflowVcoreMinutes) },
  { header: 'Pipeline runs', type: Number, value: (row) => asNumber(row.pipelineRunCount) },
  { header: 'Pipeline minutes', type: Number, value: (row) => asNumber(row.pipelineExecutionMinutes) },
  { header: 'External pipeline minutes', type: Number, value: (row) => asNumber(row.externalPipelineExecutionMinutes) },
  { header: 'Copy runs', type: Number, value: (row) => asNumber(row.copyRunCount) },
  { header: 'Copy data read (bytes)', type: Number, value: (row) => asNumber(row.copyDataReadBytes) },
  { header: 'Copy data written (bytes)', type: Number, value: (row) => asNumber(row.copyDataWrittenBytes) },
  { header: 'Copy data moved (GiB)', type: Number, value: (row) => asNumber(row.copyDataMovedGiB) },
  { header: 'Window DIU-hours', type: Number, value: (row) => asNumber(row.totalDiuHours) },
  { header: 'Est. Fabric CUh (DIU)', type: Number, value: (row) => asNumber(row.estimatedFabricCuhFromDiu) },
  { header: 'Est. Fabric CUh (Orch)', type: Number, value: (row) => asNumber(row.estimatedFabricCuhFromOrchestration) },
  { header: 'Est. Fabric CUh (MDF)', type: Number, value: (row) => asNumber(row.estimatedFabricCuhFromMappingDataflow) },
  { header: 'Est. Fabric CUh (Total)', type: Number, value: (row) => asNumber(row.estimatedFabricCuhTotal) },
  { header: 'Max Daily CUh', type: Number, value: (row) => asNumber(row.maxDailyEstimatedFabricCuh) },
  { header: 'Peak Daily CU Required', type: Number, value: (row) => asNumber(row.peakDailyCuRequired) },
];

interface ExportCell {
  value: string | number;
  type: ColumnType;
  fontFamily: string;
  fontWeight?: 'bold';
  backgroundColor?: string;
}

export function buildUsageSummarySheet(usageRows: FactoryUsageRecord[]): ExportCell[][] {
  const headerRow = exportColumns.map<ExportCell>((column) => ({
    value: column.header,
    type: String,
    fontFamily: 'Arial',
    fontWeight: 'bold',
    backgroundColor: '#DDEBF7',
  }));

  const dataRows = usageRows.map((row) =>
    exportColumns.map<ExportCell>((column) => ({
      value: column.value(row),
      type: column.type,
      fontFamily: 'Arial',
    })),
  );

  return [headerRow, ...dataRows];
}

export async function exportUsageSummaryToExcel(runId: string, usageRows: FactoryUsageRecord[]): Promise<void> {
  // Lazy-load the writer so it stays out of the main bundle.
  const module = await import('write-excel-file/browser');
  const writeXlsxFile = module.default;

  const timestamp = new Date().toISOString().replace(/[:]/g, '-');
  const fileName = `adf-usage-summary-${runId}-${timestamp}.xlsx`;

  await writeXlsxFile(buildUsageSummarySheet(usageRows)).toFile(fileName);
}
