import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../data/db';
import type {
  FactoryRecord,
  FactoryUsageRecord,
  RunRecord,
  RunStepRecord,
  SubscriptionProgressRecord,
  SubscriptionRecord,
} from '../types/azure';

interface PlannerSnapshot {
  subscriptions: SubscriptionRecord[];
  factories: FactoryRecord[];
  factoryUsage: FactoryUsageRecord[];
  runs: RunRecord[];
  runSteps: RunStepRecord[];
  progress: SubscriptionProgressRecord[];
}

const initialSnapshot: PlannerSnapshot = {
  subscriptions: [],
  factories: [],
  factoryUsage: [],
  runs: [],
  runSteps: [],
  progress: [],
};

export function usePlannerData(): PlannerSnapshot {
  const snapshot = useLiveQuery(
    async () => {
      const [factoryUsage, subscriptions, factories, runs, runSteps, progress] = await Promise.all([
        db.factoryUsage.orderBy('updatedAtUtc').reverse().toArray(),
        db.subscriptions.orderBy('displayName').toArray(),
        db.factories.orderBy('name').toArray(),
        db.runs.orderBy('startedAtUtc').reverse().toArray(),
        db.runSteps.orderBy('startedAtUtc').reverse().toArray(),
        db.subscriptionProgress.orderBy('updatedAtUtc').reverse().toArray(),
      ]);

      return {
        subscriptions: subscriptions as SubscriptionRecord[],
        factories: factories as FactoryRecord[],
        factoryUsage: factoryUsage as FactoryUsageRecord[],
        runs: runs as RunRecord[],
        runSteps: runSteps as RunStepRecord[],
        progress: progress as SubscriptionProgressRecord[],
      };
    },
    [],
  );

  return useMemo(() => (snapshot ?? initialSnapshot) as PlannerSnapshot, [snapshot]);
}
