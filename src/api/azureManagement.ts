import { InteractionRequiredAuthError, type IPublicClientApplication } from '@azure/msal-browser';
import { armScopes, loginRequest } from '../auth/msalConfig';
import type { FactoryRecord, SubscriptionRecord } from '../types/azure';
import { utcNow } from '../utils/time';

const ARM_ENDPOINT = 'https://management.azure.com';
const GRAPH_ENDPOINT = `${ARM_ENDPOINT}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01`;
const MSAL_TOKEN_TIMEOUT_MS = Number(import.meta.env.VITE_MSAL_TOKEN_TIMEOUT_MS ?? 30000);
const ARM_FETCH_TIMEOUT_MS = Number(import.meta.env.VITE_ARM_FETCH_TIMEOUT_MS ?? 45000);

interface ResourceGraphResponse<T> {
  data?: T[];
}

interface ResourceGraphFactory {
  id: string;
  name: string;
  subscriptionId: string;
  resourceGroup: string;
  location: string;
  tags?: Record<string, string>;
}

interface SubscriptionApiRecord {
  subscriptionId: string;
  displayName: string;
  state?: string;
  tenantId?: string;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function getAccessToken(msalInstance: IPublicClientApplication): Promise<string> {
  const account = msalInstance.getActiveAccount() ?? msalInstance.getAllAccounts()[0] ?? null;

  if (!account) {
    throw new Error('No signed-in account found. Sign in and retry the action.');
  }

  try {
    const token = await withTimeout(
      msalInstance.acquireTokenSilent({ account, scopes: armScopes }),
      MSAL_TOKEN_TIMEOUT_MS,
      'Silent token acquisition',
    );
    return token.accessToken;
  } catch (error) {
    if (error instanceof InteractionRequiredAuthError) {
      const token = await withTimeout(
        msalInstance.acquireTokenPopup({ scopes: armScopes, prompt: 'select_account', redirectUri: loginRequest.redirectUri }),
        Math.max(MSAL_TOKEN_TIMEOUT_MS, 120000),
        'Interactive token acquisition',
      );
      return token.accessToken;
    }

    throw error;
  }
}

async function armFetch<T>(msalInstance: IPublicClientApplication, url: string, init?: RequestInit): Promise<T> {
  const accessToken = await getAccessToken(msalInstance);
  const abortController = new AbortController();
  const timeoutMs = Number.isFinite(ARM_FETCH_TIMEOUT_MS) && ARM_FETCH_TIMEOUT_MS > 0 ? ARM_FETCH_TIMEOUT_MS : 45000;
  const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);

  let response: Response;

  try {
    response = await fetch(url, {
      ...init,
      signal: abortController.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`Azure request timed out after ${Math.round(timeoutMs / 1000)}s: ${url}`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Azure request failed (${response.status}): ${body}`);
  }

  return (await response.json()) as T;
}

export async function listSubscriptions(msalInstance: IPublicClientApplication): Promise<SubscriptionRecord[]> {
  const payload = await armFetch<{ value: SubscriptionApiRecord[] }>(
    msalInstance,
    `${ARM_ENDPOINT}/subscriptions?api-version=2022-12-01`,
  );

  const discoveredAtUtc = utcNow();

  return payload.value.map((subscription) => ({
    id: subscription.subscriptionId,
    subscriptionId: subscription.subscriptionId,
    displayName: subscription.displayName,
    tenantId: subscription.tenantId,
    state: subscription.state,
    discoveredAtUtc,
  }));
}

export async function inventoryFactoriesForSubscription(
  msalInstance: IPublicClientApplication,
  subscriptionId: string,
): Promise<FactoryRecord[]> {
  const body = {
    subscriptions: [subscriptionId],
    query:
      "Resources | where type =~ 'microsoft.datafactory/factories' | project id, name, subscriptionId, resourceGroup, location, tags",
    options: {
      resultFormat: 'objectArray',
    },
  };

  const payload = await armFetch<ResourceGraphResponse<ResourceGraphFactory>>(msalInstance, GRAPH_ENDPOINT, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const discoveredAtUtc = utcNow();

  return (payload.data ?? []).map((factory) => ({
    id: factory.id,
    name: factory.name,
    subscriptionId: factory.subscriptionId,
    resourceGroup: factory.resourceGroup,
    location: factory.location,
    discoveredAtUtc,
    tags: factory.tags,
  }));
}
