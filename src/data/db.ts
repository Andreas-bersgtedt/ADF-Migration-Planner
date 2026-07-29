import Dexie, { type EntityTable } from 'dexie';
import type {
  FactoryUsageRecord,
  FactoryRecord,
  RunRecord,
  RunStepRecord,
  SubscriptionProgressRecord,
  SubscriptionRecord,
} from '../types/azure';

export class PlannerDb extends Dexie {
  subscriptions!: EntityTable<SubscriptionRecord, 'id'>;
  factories!: EntityTable<FactoryRecord, 'id'>;
  factoryUsage!: EntityTable<FactoryUsageRecord, 'id'>;
  runs!: EntityTable<RunRecord, 'runId'>;
  runSteps!: EntityTable<RunStepRecord, 'stepId'>;
  subscriptionProgress!: EntityTable<SubscriptionProgressRecord, 'id'>;

  constructor() {
    super('adf-migration-planner');

    this.version(1).stores({
      subscriptions: 'id, subscriptionId, displayName, discoveredAtUtc',
      factories: 'id, subscriptionId, name, resourceGroup, location, discoveredAtUtc',
      runs: 'runId, tenantId, status, startedAtUtc, currentSubscriptionId',
      runSteps: 'stepId, runId, subscriptionId, stepName, status, startedAtUtc',
      subscriptionProgress: 'id, runId, subscriptionId, status, updatedAtUtc',
    });

    this.version(2).stores({
      subscriptions: 'id, subscriptionId, displayName, discoveredAtUtc',
      factories: 'id, subscriptionId, name, resourceGroup, location, discoveredAtUtc',
      factoryUsage: 'id, runId, subscriptionId, factoryId, status, updatedAtUtc',
      runs: 'runId, tenantId, status, startedAtUtc, currentSubscriptionId',
      runSteps: 'stepId, runId, subscriptionId, stepName, status, startedAtUtc',
      subscriptionProgress: 'id, runId, subscriptionId, status, updatedAtUtc',
    });
  }
}

export const db = new PlannerDb();
