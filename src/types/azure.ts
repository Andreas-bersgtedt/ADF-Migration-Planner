export type StepStatus = 'not-started' | 'running' | 'succeeded' | 'failed';

export interface SubscriptionRecord {
  id: string;
  subscriptionId: string;
  displayName: string;
  tenantId?: string;
  state?: string;
  discoveredAtUtc: string;
}

export interface FactoryRecord {
  id: string;
  name: string;
  subscriptionId: string;
  resourceGroup: string;
  location: string;
  discoveredAtUtc: string;
  tags?: Record<string, string>;
}

export interface FactoryUsageRecord {
  id: string;
  runId: string;
  factoryId: string;
  factoryName: string;
  subscriptionId: string;
  windowDays: number;
  totalDayChunks: number;
  scannedDayChunks: number;
  failedDayChunks: number;
  activityRunCount: number;
  orchestrationActivityRunCount: number;
  mappingDataflowRunCount: number;
  mappingDataflowVcoreMinutes: number;
  copyRunCount: number;
  copyDataReadBytes?: number;
  copyDataWrittenBytes?: number;
  copyDataMovedGiB?: number;
  pipelineRunCount: number;
  pipelineExecutionMinutes: number;
  externalPipelineExecutionMinutes: number;
  totalDiuHours: number;
  estimatedFabricCuhFromDiu: number;
  estimatedFabricCuhFromOrchestration: number;
  estimatedFabricCuhFromMappingDataflow: number;
  estimatedFabricCuhTotal: number;
  maxDailyEstimatedFabricCuh: number;
  peakDailyCuRequired: number;
  dailyMetrics?: FactoryDailyMetric[];
  status: 'pending' | 'collected' | 'stubbed' | 'failed';
  note?: string;
  updatedAtUtc: string;
}

export interface FactoryDailyMetric {
  metricDate: string;
  estimatedFabricCuh: number;
  status: 'completed' | 'partial' | 'failed';
}

export interface RunRecord {
  runId: string;
  tenantId: string;
  startedAtUtc: string;
  completedAtUtc?: string;
  status: 'running' | 'paused' | 'failed' | 'completed';
  currentSubscriptionId?: string;
  currentStep?: string;
}

export interface RunStepRecord {
  stepId: string;
  runId: string;
  subscriptionId?: string;
  stepName: string;
  status: StepStatus;
  startedAtUtc: string;
  completedAtUtc?: string;
  message?: string;
}

export interface SubscriptionProgressRecord {
  id: string;
  runId: string;
  subscriptionId: string;
  subscriptionName?: string;
  status:
    | 'not-started'
    | 'inventory-running'
    | 'inventory-complete'
    | 'usage-running'
    | 'usage-complete'
    | 'failed';
  lastStep?: string;
  updatedAtUtc: string;
  errorMessage?: string;
}
