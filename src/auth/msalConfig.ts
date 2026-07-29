import type { Configuration, PopupRequest } from '@azure/msal-browser';

const clientId = import.meta.env.VITE_AZURE_CLIENT_ID?.trim() ?? '';
const tenantId = import.meta.env.VITE_AZURE_TENANT_ID ?? 'organizations';
const redirectUri = import.meta.env.VITE_AZURE_REDIRECT_URI ?? window.location.origin;

export const isMsalConfigured = clientId.length > 0;
export const msalConfigurationError = isMsalConfigured
  ? null
  : 'Missing VITE_AZURE_CLIENT_ID. Copy .env.local.example to .env.local and set your SPA app registration values.';

export const armScopes = ['https://management.azure.com/.default'];

export const msalConfig: Configuration = {
  auth: {
    clientId,
    authority: `https://login.microsoftonline.com/${tenantId}`,
    redirectUri,
    postLogoutRedirectUri: window.location.origin,
  },
  cache: {
    cacheLocation: 'localStorage',
  },
};

export const loginRequest: PopupRequest = {
  scopes: armScopes,
  prompt: 'select_account',
  redirectUri,
};
